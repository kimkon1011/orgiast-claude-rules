#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnvText } from './env-kv.mjs';
import { VENDOR_TO_SERVICE } from './cloud-contract-fill.mjs';
import { collectLocalUsage, monthWindow, normalizeProvider } from './ai-usage-local.mjs';
import { isEntry } from './is-entry.mjs';

const missing = 'freeeに無い（要確認）';
const money = (value) => typeof value === 'number' && Number.isFinite(value) ? value : null;
export function serviceForVendor(vendor) {
  const normalized = normalizeProvider(vendor);
  const targets = VENDOR_TO_SERVICE[normalized.replace(/_/g, ' ')];
  return targets?.length === 1 ? targets[0] : normalized;
}
export function reconcileCosts(freee, local, { months = 13, now = new Date(), force = false } = {}) {
  if (freee?.currency !== 'JPY' || !Array.isArray(freee.vendors)) throw new Error('freee入力は currency:JPY と vendors 配列が必要です');
  if (!local?.months || typeof local.months !== 'object' || Array.isArray(local.months)) throw new Error('local入力の months が不正です');
  if (!Number.isFinite(local.jpyPerUsd) || local.jpyPerUsd <= 0) throw new Error('local入力に有効な jpyPerUsd が必要です');
  const window = monthWindow(months, now), joined = new Map();
  const get = (month, vendor) => {
    const service = serviceForVendor(vendor);
    if (!service) throw new Error('サービス名が空です');
    const key = JSON.stringify([month, service]);
    if (!joined.has(key)) joined.set(key, { month, service, freee: [], local: [], payers: new Set(), payerUnknown: false });
    return joined.get(key);
  };
  for (const vendor of freee.vendors) {
    for (const [month, amount] of Object.entries(vendor.monthly || {})) {
      if (!window.includes(month)) continue;
      const entry = get(month, vendor.vendor);
      entry.freee.push(money(amount));
      if (vendor.payers?.length === 1 && vendor.payers[0].name) entry.payers.add(vendor.payers[0].name);
      else entry.payerUnknown = true;
    }
  }
  for (const [month, providers] of Object.entries(local.months)) {
    if (!window.includes(month)) continue;
    for (const [provider, usage] of Object.entries(providers)) {
      if (!usage || typeof usage !== 'object') throw new Error('local利用明細が不正です');
      const fixed = usage.billing === '定額' || (usage.billing == null && usage.jpy === null && ['ANTHROPIC', 'OPENAI'].includes(normalizeProvider(provider)));
      get(month, provider).local.push({ jpy: money(usage.jpy), billing: fixed ? '定額' : usage.billing || (money(usage.jpy) === null ? '判定不能' : '従量') });
    }
  }
  const sum = (values) => values.length && values.every((value) => value !== null) ? values.reduce((a, b) => a + b, 0) : null;
  const updatedAt = new Date(+now + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19) + ' JST';
  const rows = [...joined.values()].sort((a, b) => a.month.localeCompare(b.month) || a.service.localeCompare(b.service)).map((entry) => {
    const hasFreee = entry.freee.length > 0, hasLocal = entry.local.length > 0;
    const freeeJpy = sum(entry.freee), localJpy = sum(entry.local.map((value) => value.jpy));
    const billings = new Set(entry.local.map((value) => value.billing));
    const billing = billings.size === 1 ? [...billings][0] : '判定不能';
    let state = hasFreee && hasLocal ? '両方にあり' : hasFreee ? '実測に無い' : missing;
    if (freeeJpy === null && localJpy === null && billing !== '定額') state = '判定不能';
    return { month: entry.month, service: entry.service, billing, freeeJpy, localJpy,
      difference: freeeJpy === null || localJpy === null ? '' : freeeJpy - localJpy,
      state, ...(entry.payers.size === 1 && !entry.payerUnknown ? { payerName: [...entry.payers][0] } : {}),
      evidence: hasFreee && hasLocal ? '両方' : hasFreee ? 'freee明細' : 'ローカル実測', updatedAt };
  });
  const pending = rows.filter((row) => row.state === missing).map((row) => ({ month: row.month, service: row.service, amount: row.localJpy,
    ...(row.payerName ? { payerName: row.payerName } : {}), description: `AI利用料 ${row.service} ${row.month}`, detectedAt: updatedAt.slice(0, 10) }));
  return { summary: { kind: 'ai-cost-summary', rows, force }, pending: { kind: 'ai-cost-pending', months: window, rows: pending, force }, jpyPerUsd: local.jpyPerUsd };
}
function parseArgs(args) {
  const options = { months: 13, dryRun: false, force: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--force') options.force = true;
    else if (['--freee', '--local', '--months'].includes(arg) && args[i + 1] && !args[i + 1].startsWith('--')) options[arg.slice(2)] = arg === '--months' ? Number(args[++i]) : args[++i];
    else throw new Error(`不明な引数: ${arg}`);
  }
  if (!options.freee) throw new Error('--freee <path> が必要です');
  monthWindow(options.months);
  return options;
}
async function postJson(url, payload, fetchImpl) {
  const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  let result;
  try { result = JSON.parse(await response.text()); } catch { throw new Error(`HTTP ${response.status}: JSONではない応答`); }
  if (!response.ok || result?.ok !== true) throw new Error(`HTTP ${response.status}: ${result?.error || 'ok:true がありません'}`);
  return result;
}
function validateDescription(description) {
  for (const [name, required] of Object.entries({
    AI費用サマリ: ['年月','サービス','課金形態','freee計上額(円)','実測利用額(円)','差額(円)','状態','支払い元(名義)','根拠','備考','更新日時(JST)'],
    freee登録待ち: ['年月','サービス','金額(円)','支払い元(名義)','摘要(案)','勘定科目','税区分','登録済み','検出日'],
  })) {
    const tab = description.tabs?.[name];
    if (!tab || !Array.isArray(tab.headers) || !Number.isInteger(tab.rowCount) || tab.rowCount < 0) throw new Error(`台帳診断が不正: ${name}`);
    if (tab.headers.length && required.some((header) => !tab.headers.includes(header))) throw new Error(`台帳ヘッダが不足: ${name}`);
  }
}
export async function run(args = process.argv.slice(2), dependencies = {}) {
  const io = dependencies.io ?? console, home = dependencies.home ?? process.env.ORGIAST_HOME ?? os.homedir();
  let env = {};
  try { env = parseEnvText(fs.readFileSync(path.join(home, '.claude', 'fleet-sheet.env'), 'utf8')); } catch { /* optional configuration */ }
  if (!env.FLEET_SHEET_URL || !env.FLEET_SHEET_TOKEN) { io.error('ai-cost-unify: FLEET_SHEET_URL/TOKEN 未設定のため実行しません'); return 0; }
  try {
    const options = parseArgs(args), now = dependencies.now ?? new Date();
    const freee = JSON.parse(fs.readFileSync(options.freee, 'utf8'));
    const local = options.local ? JSON.parse(fs.readFileSync(options.local, 'utf8')) : (dependencies.collectLocalUsage ?? collectLocalUsage)({ home, months: options.months, now });
    const result = reconcileCosts(freee, local, { ...options, now });
    const post = (payload) => postJson(env.FLEET_SHEET_URL, { ...payload, token: env.FLEET_SHEET_TOKEN }, dependencies.fetchImpl ?? fetch);
    // 読み取り失敗時はdry-runも失敗にする。想定のヘッダやキーで代用しない。
    const description = await post({ kind: 'ai-cost-describe' });
    validateDescription(description);
    io.log(`台帳読取: AI費用サマリ ${description.tabs['AI費用サマリ'].rowCount}行 / freee登録待ち ${description.tabs['freee登録待ち'].rowCount}行`);
    if (!options.dryRun) { await post(result.summary); await post(result.pending); }
    io.log(`${options.dryRun ? '[dry-run] 書き込み予定' : '送信・適用成功'}: サマリ ${result.summary.rows.length}行 / 登録待ち ${result.pending.rows.length}行（既存セルの上書き: ${options.force ? 'あり' : '空セルのみ'}）`);
    for (const state of [missing, '実測に無い']) {
      const rows = result.summary.rows.filter((row) => row.state === state);
      io.log(`${state}: ${rows.length}件`);
      for (const row of rows) io.log(`  ${row.month} / ${row.service} / ${row.localJpy ?? row.freeeJpy ?? '金額不明'}${row.localJpy === null && row.freeeJpy === null ? '' : '円'}`);
    }
    io.log(`換算レート: 1 USD = ${result.jpyPerUsd} JPY（トークン利用額は概算。定額枠は金額不明）`);
    io.log(`freee入力期間: ${freee.period?.start ?? '不明'} ～ ${freee.period?.end ?? '不明'} / 未分類明細: ${freee.unmatched?.length ?? 0}件（別途確認）`);
    return 0;
  } catch (error) { io.error(`ai-cost-unify: ${error.message}`); return 1; }
}
if (isEntry(import.meta.url)) process.exitCode = await run();
