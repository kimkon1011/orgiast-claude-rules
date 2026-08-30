#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvText } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

export const VENDOR_TO_SERVICE = Object.freeze({
  ANTHROPIC: ['Anthropic (Claude Code)', 'Anthropic API'],
  GITHUB: ['GitHub'],
  'GITHUB INC': ['GitHub'],
  VERCEL: ['Vercel'],
  'GOOGLE CLOUD': ['Google Cloud'],
  GOOGLE: ['Google Cloud', 'Google Workspace'],
  OPENAI: ['OpenAI (Codex CLI / ChatGPT)'],
  'OPENAI CHATGPT': ['OpenAI (Codex CLI / ChatGPT)'],
  'GOOGLE WORKSPACE': ['Google Workspace'],
  SUPABASE: ['Supabase'],
  GROQ: ['Groq'],
  DEEPSEEK: ['DeepSeek'],
  OPENROUTER: ['OpenRouter'],
  MOONSHOT: ['Moonshot (Kimi)'],
  KIMI: ['Moonshot (Kimi)'],
  MISTRAL: ['Mistral'],
  XAI: ['xAI'],
  DISCORD: ['Discord'],
  'TL;DV': ['tl;dv'],
  TACTIQ: ['Tactiq'],
  PLAUD: ['Plaud'],
  CANVA: ['Canva'],
  'PR TIMES': ['PR TIMES'],
  WORDPRESS: ['WordPress / レンタルサーバ'],
  'レンタルサーバ': ['WordPress / レンタルサーバ'],
  マキモノ: ['マキモノ'],
});

const KNOWN_LEDGER_KEYS = [...new Set(Object.values(VENDOR_TO_SERVICE).flat())].map((service) => [service, '']);

// 集計側は GOOGLE_CLOUD のようにアンダースコア区切りのベンダー名を出す。
// 空白区切りの辞書と突き合わせるため、ここで区切りを揃える(揃えないと全部 missing になる)。
function normalizedVendor(value) {
  return String(value ?? '').trim().replace(/[_\s]+/g, ' ').toUpperCase();
}

function normalizeExistingKey(value) {
  if (Array.isArray(value)) return { service: String(value[0] ?? '').trim(), account: String(value[1] ?? '').trim() };
  return {
    service: String(value?.service ?? value?.['サービス'] ?? '').trim(),
    account: String(value?.account ?? value?.['アカウント(ログインID)'] ?? '').trim(),
  };
}

export function resolveVendorTargets(vendor, existingKeys) {
  const services = VENDOR_TO_SERVICE[normalizedVendor(vendor)] ?? [];
  const wanted = new Set(services);
  const targets = (Array.isArray(existingKeys) ? existingKeys : [])
    .map(normalizeExistingKey)
    .filter((key) => key.service && wanted.has(key.service));
  if (targets.length === 0) return { status: 'missing', targets: [] };
  if (targets.length > 1) return { status: 'ambiguous', targets };
  return { status: 'resolved', targets };
}

function hasValue(value) {
  return value !== undefined && value !== null && value !== '';
}

export function buildContractPayload(vendorSummary, today) {
  const payload = {};
  if (hasValue(vendorSummary?.medianMonthlyJpy)) payload.monthlyAmount = vendorSummary.medianMonthlyJpy;
  payload.currency = 'JPY';
  if (Array.isArray(vendorSummary?.payers) && vendorSummary.payers.length === 1 && hasValue(vendorSummary.payers[0]?.name)) {
    payload.payerName = vendorSummary.payers[0].name;
  }
  if (hasValue(vendorSummary?.billingCycle)) payload.billingCycle = vendorSummary.billingCycle;
  payload.checkedAt = today;
  payload.detected = '検出済み';
  return payload;
}

export function jstDate(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const get = (type) => parts.find((part) => part.type === type)?.value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function parseArgs(args) {
  const inputIndex = args.indexOf('--input');
  if (inputIndex < 0 || !args[inputIndex + 1]) throw new Error('--input <path> が必要です');
  return { input: args[inputIndex + 1], dryRun: args.includes('--dry-run'), force: args.includes('--force') };
}

function readInput(input, stdin = process.stdin) {
  return input === '-' ? fs.readFileSync(stdin.fd, 'utf8') : fs.readFileSync(input, 'utf8');
}

async function postJson(url, payload, fetchImpl) {
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { throw new Error(`HTTP ${response.status}: JSONではない応答`); }
  if (!response.ok || result.ok === false) throw new Error(`HTTP ${response.status}: ${result.error || text.slice(0, 200)}`);
  return result;
}

function unmatchedLabel(item) {
  return String(item?.vendor ?? item?.description ?? item?.name ?? item?.memo ?? '(名称なし)');
}

export async function run(args = process.argv.slice(2), dependencies = {}) {
  const io = dependencies.io ?? console;
  const home = dependencies.home ?? os.homedir();
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  let options;
  try { options = parseArgs(args); } catch (error) { io.error(`cloud-contract-fill: ${error.message}`); return 1; }

  let env = {};
  try { env = parseEnvText(fs.readFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'utf8')); } catch { /* handled below */ }
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN) {
    io.error('cloud-contract-fill: FLEET_SHEET_URL/TOKEN 未設定のため実行しません(~/.claude/fleet-sheet.env)');
    return 0;
  }

  let aggregate;
  try { aggregate = JSON.parse(readInput(options.input, dependencies.stdin)); }
  catch (error) { io.error(`cloud-contract-fill: 入力JSONを読めません: ${error.message}`); return 1; }

  let existingKeys = KNOWN_LEDGER_KEYS;
  if (!options.dryRun) {
    const description = await postJson(env.FLEET_SHEET_URL, {
      token: env.FLEET_SHEET_TOKEN, kind: 'cloud-describe',
    }, fetchImpl);
    existingKeys = description?.tabs?.['クラウド契約']?.keys ?? [];
  }

  const written = [];
  const ambiguous = [];
  const missing = [];
  const today = dependencies.today ?? jstDate();
  for (const summary of Array.isArray(aggregate.vendors) ? aggregate.vendors : []) {
    const resolution = resolveVendorTargets(summary.vendor, existingKeys);
    if (resolution.status === 'ambiguous') { ambiguous.push({ vendor: summary.vendor, targets: resolution.targets }); continue; }
    if (resolution.status === 'missing') { missing.push(summary.vendor); continue; }
    const target = resolution.targets[0];
    const contract = { service: target.service, account: target.account, ...buildContractPayload(summary, today) };
    const request = { token: env.FLEET_SHEET_TOKEN, kind: 'cloud-contract', force: options.force, ...contract };
    if (!options.dryRun) await postJson(env.FLEET_SHEET_URL, request, fetchImpl);
    written.push({ vendor: summary.vendor, target, contract });
  }

  io.log(`${options.dryRun ? '[dry-run] 書き込み予定' : '書き込み済み'}: ${written.length}行`);
  for (const item of written) io.log(`  ${item.vendor} -> ${item.target.service} / ${item.target.account || '(空アカウント)'} ${JSON.stringify(item.contract)}`);
  io.log(`ambiguous: ${ambiguous.length}件`);
  for (const item of ambiguous) io.log(`  ${item.vendor} -> ${item.targets.map((target) => `${target.service} / ${target.account || '(空アカウント)'}`).join(', ')}`);
  io.log(`台帳に行が無いベンダー: ${missing.length}件`);
  for (const vendor of missing) io.log(`  ${vendor}`);
  const unmatched = (Array.isArray(aggregate.unmatched) ? aggregate.unmatched : [])
    .slice().sort((a, b) => Number(b?.count ?? 0) - Number(a?.count ?? 0)).slice(0, 10);
  io.log(`unmatched 上位10件: ${unmatched.length}件`);
  for (const item of unmatched) io.log(`  ${unmatchedLabel(item)} (${Number(item?.count ?? 0)}件)`);
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await run();
