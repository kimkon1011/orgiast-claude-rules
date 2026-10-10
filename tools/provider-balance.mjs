#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnvValue } from './env-kv.mjs';
import { COST_PER_MILLION } from './llm-fallback.mjs';
import { summarizeGeminiMonth } from './cost-work-loop.mjs';
import { isEntry } from './is-entry.mjs';
import { notifyKim } from './notify-kim.mjs';

const repoDir = path.dirname(fileURLToPath(import.meta.url));
const DAY = 86400000;
const PROVIDERS = [
  ['deepseek', 'deepseek.env', 'DEEPSEEK_API_KEY', 'https://api.deepseek.com/user/balance'],
  ['openrouter', 'openrouter.env', 'OPENROUTER_API_KEY', 'https://openrouter.ai/api/v1/credits'],
  ['kimi', 'kimi-api.env', 'MOONSHOT_API_KEY', 'https://api.moonshot.ai/v1/users/me/balance'],
  ['genspark', 'genspark.env', 'GSK_API_KEY', 'https://www.genspark.ai/api/tool_cli/me'],
];

export const CREDIT_LOW_THRESHOLD = 5000;
export const BALANCE_LOW_THRESHOLD_USD = 5;

function dayKey(value) { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : ''; }
function finite(value) { if (value == null || value === '') return null; const n = Number(value); return Number.isFinite(n) ? n : null; }
function parseBalance(provider, json) {
  if (provider === 'deepseek') {
    const usd = json?.balance_infos?.find((x) => x?.currency === 'USD');
    return finite(usd?.total_balance);
  }
  if (provider === 'openrouter') return finite(json?.data?.total_credits) === null || finite(json?.data?.total_usage) === null ? null : finite(json.data.total_credits) - finite(json.data.total_usage);
  if (provider === 'kimi') return finite(json?.data?.available_balance);
  return null;
}

export function parseCredits(provider, json) {
  // REST は素の `credit_balance` を返す。`gsk me` の CLI は同じ値を `data` で包むので両方受ける。
  if (provider === 'genspark') return finite(json?.credit_balance ?? json?.data?.credit_balance);
  return null;
}

export async function fetchProviderBalance({ provider, url, key, fetchImpl = fetch }) {
  if (!key) return { balanceUsd: null, credits: null, reason: 'API key unavailable' };
  try {
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { balanceUsd: null, credits: null, reason: `HTTP ${response.status}` };
    const json = await response.json();
    const balanceUsd = parseBalance(provider, json);
    const credits = parseCredits(provider, json);
    return balanceUsd === null && credits === null
      ? { balanceUsd: null, credits: null, reason: 'confirmed response had no parseable USD balance' }
      : { balanceUsd, credits };
  } catch (error) { return { balanceUsd: null, credits: null, reason: `network: ${error?.message || error}` }; }
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
  if (Number.isFinite(row.credits)) return row.credits < CREDIT_LOW_THRESHOLD ? 'low' : 'ok';
  if (Number.isFinite(row.balanceUsd) && row.balanceUsd < BALANCE_LOW_THRESHOLD_USD && row.autoTopUp !== true) return 'low';
  if (row.balanceUsd === null) return 'unmeasurable';
  return 'ok';
}
export function formatBalanceLine(rows) {
  const item = (r) => r.provider === 'groq' && r.billing === 'free'
    ? `${r.provider} 無料枠(有料化不可)`
    : Number.isFinite(r.credits)
    ? `${r.provider} ${r.credits}cr(前払い)`
    : `${r.provider} ${r.balanceUsd === null ? '監視不能' : `$${r.balanceUsd.toFixed(2)}`}(${r.autoTopUp === true ? '自動あり' : r.autoTopUp === false ? '自動なし' : '自動不明'})`;
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
    if (remote.credits !== null) row.credits = remote.credits;
    if (remote.reason) row.reason = remote.reason;
    row.status = classifyBalance(row); results.push(row);
  }
  for (const provider of ['xai', 'groq']) {
    const row = { provider, balanceUsd: null, autoTopUp: billing[provider]?.autoTopUp ?? 'unknown', billing: billing[provider]?.billing, ...summarizeLedger(ledger, provider === 'xai' ? 'grok' : provider, now), reason: provider === 'groq' ? (billing.groq?.billing === 'free' ? `${billing.groq.note}; free tier; monitor spend_anomaly and 429` : 'postpaid; balance does not apply (ledger estimate only)') : 'no official balance API found; ledger estimate only' };
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

const CHARGE_URLS = {
  kimi: 'https://platform.kimi.ai/console/pay',
  deepseek: 'https://platform.deepseek.com/top_up',
  openrouter: 'https://openrouter.ai/credits',
};

// 日付は運用拠点の JST に統一。週次は前回送信から7日空け、曜日も維持する。
function alertDay(now) { return dayKey(new Date(now.getTime() + 9 * 3600000)); }
function balanceLabel(row) {
  return Number.isFinite(row.credits) ? `${row.credits}cr`
    : Number.isFinite(row.balanceUsd) ? `$${row.balanceUsd.toFixed(2)}` : '残高不明';
}

export async function alertProviderBalances(rows, {
  home = process.env.ORGIAST_HOME || os.homedir(), now = new Date(), dryRun = false,
  notify = notifyKim, log = console.log, warn = console.error,
} = {}) {
  const file = path.join(home, '.claude', 'provider-balance-alert-state.json');
  const lock = `${file}.lock`;
  let locked = false;
  let temporary;
  try {
    // 同時起動による重複DMを防止。異常終了したロックは5分後に再取得する。
    if (!dryRun) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 5 * 60000) fs.rmdirSync(lock); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      fs.mkdirSync(lock); locked = true;
    }
    let state = { version: 1, providers: {} };
    try { state = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (state.version !== 1 || !state.providers || typeof state.providers !== 'object') throw new Error('invalid state');
    const today = alertDay(now);
    const lines = [];
    for (const row of rows) {
      const prior = state.providers[row.provider] || {};
      const next = { ...prior };
      const low = row.status === 'low' || (Number.isFinite(row.balanceUsd)
        && row.balanceUsd < BALANCE_LOW_THRESHOLD_USD && row.autoTopUp === false);
      const lowState = `low:${row.autoTopUp}`;
      if (low) {
        if (prior.lowDay !== today || prior.lowState !== lowState) {
          const topUp = row.autoTopUp === false ? 'OFF' : row.autoTopUp === true ? 'ON' : '不明';
          lines.push(`残高注意: ${row.provider} ${balanceLabel(row)}（オートチャージ ${topUp}）${CHARGE_URLS[row.provider] ? `。チャージ画面: ${CHARGE_URLS[row.provider]}` : ''}`);
          next.lowDay = today; next.lowState = lowState;
        }
        next.lowActive = true;
      } else if (row.status === 'ok' && prior.lowActive) {
        lines.push(`復旧: ${row.provider} ${balanceLabel(row)}`);
        next.lowActive = false;
      }
      if (row.autoTopUp === false && (!prior.offDay || Date.parse(today) - Date.parse(prior.offDay) >= 7 * DAY)) {
        // low通知にはOFFも明示済み。同じプロバイダの重複行を避ける。
        if (!low) lines.push(`オートチャージが OFF: ${row.provider}（方針は全プロバイダ ON）`);
        next.offDay = today;
      }
      state.providers[row.provider] = next;
    }
    const text = lines.join('\n');
    if (dryRun) {
      log(text ? `[dry-run] Discord DM（送信なし）\n${text}` : '[dry-run] 通知対象なし');
      return { delivered: 'dry-run', lines };
    }
    if (lines.length) {
      // 切り詰めで残高注意を失わない。現在の全プロバイダをまとめても2,000文字未満。
      if (text.length > 2000) throw new Error('DM too long');
      const result = await notify(text, { home, webhookFallback: false });
      if (result?.delivered !== 'dm') throw new Error('DM not delivered');
    }
    // DM成功後だけ確定。失敗時は次回同じ通知を再試行する。
    temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n');
    fs.renameSync(temporary, file);
    if (lines.length) log(`provider-balance: Discord DM 配信成功 (${lines.length}行)`);
    return { delivered: lines.length ? 'dm' : 'none', lines };
  } catch (error) {
    // 例外本文は秘密値を含む可能性があるためログに出さない。日次処理は継続。
    warn(`provider-balance: 残高DM未完了（${error?.code === 'EEXIST' ? '別の実行が処理中' : '状態保存または通知に失敗'}）。次回再試行します`);
    return { delivered: 'failed', lines: [] };
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch {} }
    if (locked) { try { fs.rmdirSync(lock); } catch {} }
  }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const invalid = argv.find(arg => !['--json', '--alert', '--dry-run'].includes(arg));
  if (invalid || (argv.includes('--dry-run') && !argv.includes('--alert'))) {
    console.error('Usage: provider-balance.mjs [--json] [--alert [--dry-run]]');
    return 2;
  }
  const dryRun = argv.includes('--dry-run');
  const rows = await (io.collect ?? collectProviderBalances)({ ...io, appendHistory: !dryRun });
  let alerts;
  if (argv.includes('--alert')) alerts = await alertProviderBalances(rows, {
    ...io, dryRun, log: argv.includes('--json') ? () => {} : (io.log ?? console.log),
  });
  if (argv.includes('--json')) console.log(JSON.stringify(alerts ? { providers: rows, alerts } : rows, null, 2));
  else { console.log(formatBalanceLine(rows)); for (const r of rows) console.log(`${r.provider}\tbalance=${Number.isFinite(r.credits) ? `${r.credits}cr` : r.balanceUsd === null ? 'unmeasurable' : `$${r.balanceUsd.toFixed(2)}`}\ttoday=$${r.todaySpendUsd.toFixed(4)}\tavg7d=$${r.avg7dSpendUsd.toFixed(4)}\tstatus=${r.status}${r.reason ? `\treason=${r.reason}` : ''}`); }
  return 0;
}
if (isEntry(import.meta.url)) process.exitCode = await main();
