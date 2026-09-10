#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvValue } from './env-kv.mjs';
import { COST_PER_MILLION } from './llm-fallback.mjs';
import { summarizeGeminiMonth } from './cost-work-loop.mjs';
import { isEntry } from './is-entry.mjs';

const repoDir = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;
const PROVIDERS = [
  ['deepseek', 'deepseek.env', 'DEEPSEEK_API_KEY', 'https://api.deepseek.com/user/balance'],
  ['openrouter', 'openrouter.env', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1/credits'],
  ['kimi', 'kimi-api.env', 'MOONSHOT_API_KEY', 'https://api.moonshot.ai/v1/users/me/balance'],
];

function dayKey(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : ''; }
function finite(value) { const n = Number(value); return Number.isFinite(n) ? n : null; }
function parseBalance(provider, json) {
  if (provider === 'deepseek') {
    const usd = json?.balance_infos?.find((x) => x?.currency === 'USD');
    return finite(usd?.total_balance);
  }
  if (provider === 'openrouter') return finite(json?.data?.total_credits) === null || finite(json?.data?.total_usage) === null ? null : finite(json.data.total_credits) - finite(json.data.total_usage);
  if (provider === 'kimi') return finite(json?.data?.available_balance);
  return null;
}

export async function fetchProviderBalance({ provider, url, key, fetchImpl = fetch }) {
  if (!key) return { balanceUsd: null, reason: 'API key unavailable' };
  try {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { balanceUsd: null, reason: `HTTP ${response.status}` };
    const balanceUsd = parseBalance(provider, await response.json());
    return balanceUsd === null ? { balanceUsd: null, reason: 'confirmed response had no parseable USD balance' } : { balanceUsd };
  } catch (error) { return { balanceUsd: null, reason: `network: ${error?.message || error}` }; }
}

export function summarizeLedger(rows, provider, now = new Date()) {
  const sums = new Map();
  for (const row of rows) {
    if (String(row?.provider).toLowerCase() !== provider) continue;
    const rate = COST_PER_MILLION[provider];
    const day = dayKey(row.t);
    if (!rate || !day) continue;
    const cost = ((Number(row.in) || 0) * rate[0] + (Number(row.out) || 0) * rate[1]) / 1e6;
    sums.set(day, (sums.get(day) || 0) + cost);
  }
  const today = dayKey(now);
  const previous = Array.from({ length: 7 }, (_, i) => dayKey(now.getTime() - (i + 1) * DAY));
  return { todaySpendUsd: sums.get(today) || 0, avg7dSpendUsd: previous.reduce((n, d) => n + (sums.get(d) || 0), 0) / 7 };
}

function readRows(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch { return []; }
}
export function classifyBalance(row) {
  if (row.todaySpendUsd >= 1 && row.todaySpendUsd > 2 * row.avg7dSpendUsd) return 'anomaly';
  if (row.balanceUsd !== null && row.balanceUsd < 3 && row.autoTopUp !== true) return 'low';
  if (row.balanceUsd === null) return 'unmeasurable';
  return 'ok';
}
export function formatBalanceLine(rows) {
  const item = (r) => `${r.provider} ${r.balanceUsd === null ? '監視不能' : `$${r.balanceUsd.toFixed(2)}`}(${r.autoTopUp === true ? '自動あり' : r.autoTopUp === false ? '自動なし' : '自動不明'})`;
  return `💳 残高: ${rows.map(item).join(' / ')}`;
}

export async function collectProviderBalances({ home = process.env.ORGIAST_HOME || os.homedir(), now = new Date(), fetchImpl = fetch, appendHistory = true } = {}) {
  const claudeDir = path.join(home, '.claude');
  const billing = JSON.parse(fs.readFileSync(path.join(repoDir, 'provider-billing.json'), 'utf8'));
  const ledger = readRows(path.join(claudeDir, 'executor-usage.jsonl'));
  const results = [];
  for (const [provider, envFile, keyName, url] of PROVIDERS) {
    const key = process.env[keyName] || readEnvValue(path.join(claudeDir, envFile), keyName);
    const remote = await fetchProviderBalance({ provider, url, key, fetchImpl });
    const row = { provider, balanceUsd: remote.balanceUsd, autoTopUp: billing[provider]?.autoTopUp ?? 'unknown', ...summarizeLedger(ledger, provider, now) };
    if (remote.reason) row.reason = remote.reason;
    row.status = classifyBalance(row); results.push(row);
  }
  for (const provider of ['xai', 'groq']) {
    const row = { provider, balanceUsd: null, autoTopUp: billing[provider]?.autoTopUp ?? 'unknown', ...summarizeLedger(ledger, provider === 'xai' ? 'grok' : provider, now), reason: provider === 'groq' ? 'postpaid; balance does not apply (ledger estimate only)' : 'no official balance API found; ledger estimate only' };
    row.status = classifyBalance(row); results.push(row);
  }
  const geminiRows = ledger.filter((x) => ['gemini', 'gemini-cli'].includes(x.provider));
  const geminiMonth = summarizeGeminiMonth(geminiRows, { now });
  const gemini = { provider: 'gemini', balanceUsd: null, autoTopUp: billing.gemini?.autoTopUp ?? 'unknown', ...summarizeLedger(ledger, 'gemini', now), reason: `quota monitor: ${geminiMonth.searches ?? 0} searches this month; no balance API` };
  gemini.status = classifyBalance(gemini); results.push(gemini);
  if (appendHistory) {
    try {
      const file = path.join(claudeDir, 'provider-balances.jsonl');
      const today = dayKey(now); const prior = readRows(file);
      if (!prior.some((x) => dayKey(x.t) === today)) { fs.mkdirSync(claudeDir, { recursive: true }); fs.appendFileSync(file, `${JSON.stringify({ t: now.toISOString(), providers: results })}\n`); }
    } catch (error) { console.error(`provider balance history unavailable: ${error?.code || error?.message || error}`); }
  }
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  const rows = await collectProviderBalances();
  if (argv.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else { console.log(formatBalanceLine(rows)); for (const r of rows) console.log(`${r.provider}\tbalance=${r.balanceUsd === null ? 'unmeasurable' : `$${r.balanceUsd.toFixed(2)}`}\ttoday=$${r.todaySpendUsd.toFixed(4)}\tavg7d=$${r.avg7dSpendUsd.toFixed(4)}\tstatus=${r.status}${r.reason ? `\treason=${r.reason}` : ''}`); }
}
if (isEntry(import.meta.url)) await main();
