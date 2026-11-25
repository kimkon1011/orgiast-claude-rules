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

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function monthKey(date) {
  const value = typeof date === 'string' ? date : date?.toISOString?.();
  const match = String(value ?? '').match(/^(\d{4})-(\d{2})/);
  if (!match) throw new Error(`today は日付形式で指定してください: ${date}`);
  return `${match[1]}-${match[2]}`;
}

function shiftMonth(key, offset) {
  const [year, month] = key.split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + offset, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
}

function chargedEntries(monthly) {
  return Object.entries(monthly && typeof monthly === 'object' ? monthly : {})
    .filter(([key, amount]) => /^\d{4}-(0[1-9]|1[0-2])$/.test(key) && Number(amount) > 0)
    .map(([key, amount]) => [key, Number(amount)]);
}

export function classifyBilling(monthly, today) {
  const charged = chargedEntries(monthly);
  if (charged.length === 0) {
    return { status: 'none', monthlyJpy: null, billingCycle: '', lastChargedMonth: null, activeMonths: 0 };
  }

  const currentMonth = monthKey(today);
  const recent3 = new Set(Array.from({ length: 3 }, (_, index) => shiftMonth(currentMonth, -index)));
  const recent6 = new Set(Array.from({ length: 6 }, (_, index) => shiftMonth(currentMonth, -index)));
  const recentAmounts = charged.filter(([key]) => recent3.has(key)).map(([, amount]) => amount);
  const lastChargedMonth = charged.map(([key]) => key).sort().at(-1);
  if (recentAmounts.length >= 2) {
    const activeInSixMonths = charged.filter(([key]) => recent6.has(key)).length;
    return {
      status: 'active',
      monthlyJpy: median(recentAmounts),
      billingCycle: activeInSixMonths >= 5 ? '月次' : '',
      lastChargedMonth,
      activeMonths: charged.length,
    };
  }
  return { status: 'stale', monthlyJpy: null, billingCycle: '', lastChargedMonth, activeMonths: charged.length };
}

export function buildContractPayload(vendorSummary, today) {
  const classification = classifyBilling(vendorSummary?.monthly, today);
  const payload = {};
  if (classification.status === 'active') {
    payload.monthlyAmount = classification.monthlyJpy;
    payload.currency = 'JPY';
  }
  if (Array.isArray(vendorSummary?.payers) && vendorSummary.payers.length === 1 && hasValue(vendorSummary.payers[0]?.name)) {
    payload.payerName = vendorSummary.payers[0].name;
  }
  if (classification.billingCycle) payload.billingCycle = classification.billingCycle;
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

  // 台帳の実キーは dry-run でも取りに行く。cloud-describe は読み取りだけで台帳を変えない。
  // 内蔵辞書で代用すると「実在しない行に書き込む予定」と表示され、dry-run が予行演習にならない。
  let existingKeys = KNOWN_LEDGER_KEYS;
  try {
    const description = await postJson(env.FLEET_SHEET_URL, {
      token: env.FLEET_SHEET_TOKEN, kind: 'cloud-describe',
    }, fetchImpl);
    existingKeys = description?.tabs?.['クラウド契約']?.keys ?? [];
  } catch (error) {
    // 本番書き込みは実キーが無いと他行を壊しうるので中止する。dry-run は内蔵辞書で続行し、その旨を明示する。
    if (!options.dryRun) { io.error(`cloud-contract-fill: 台帳を読めませんでした: ${error.message}`); return 1; }
    io.log(`[dry-run] 台帳を読めなかったため内蔵辞書で代用します（実際の行とは異なる可能性）: ${error.message}`);
  }

  const written = [];
  const ambiguous = [];
  const missing = [];
  const stale = [];
  const today = dependencies.today ?? jstDate();
  for (const summary of Array.isArray(aggregate.vendors) ? aggregate.vendors : []) {
    const classification = classifyBilling(summary.monthly, today);
    if (classification.status === 'stale') {
      const historicalAmounts = chargedEntries(summary.monthly).map(([, amount]) => amount);
      stale.push({
        vendor: summary.vendor,
        lastChargedMonth: classification.lastChargedMonth,
        previousMonthlyJpy: median(historicalAmounts),
      });
    }
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
  if (stale.length === 0) io.log('⚠️ 直近3か月の課金が1回以下＝月額を書かない（年払い / 単発 / 解約 / freee未同期のカード の可能性）: 0件');
  for (const item of stale) {
    io.log(`⚠️ 直近3か月の課金が1回以下＝月額を書かない（年払い / 単発 / 解約 / freee未同期のカード の可能性）: ${item.vendor} (最終課金 ${item.lastChargedMonth}, 月額だった額 ¥${item.previousMonthlyJpy.toLocaleString('ja-JP')})`);
  }
  io.log(`台帳に行が無いベンダー: ${missing.length}件`);
  for (const vendor of missing) io.log(`  ${vendor}`);
  const unmatched = (Array.isArray(aggregate.unmatched) ? aggregate.unmatched : [])
    .slice().sort((a, b) => Number(b?.amount ?? 0) - Number(a?.amount ?? 0)).slice(0, 10);
  // 辞書を育てるための材料。金額の大きい順に出す(件数はこの配列に無いので出さない)。
  io.log(`辞書に無かった明細 上位10件(金額順・全${Number(aggregate.unmatchedTotalCount ?? unmatched.length)}件):`);
  for (const item of unmatched) io.log(`  ¥${Number(item?.amount ?? 0).toLocaleString('ja-JP')} ${unmatchedLabel(item)}`);
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await run();
