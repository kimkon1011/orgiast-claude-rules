#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { geminiHome } from './gemini-usage-ledger.mjs';
import { notifyKim } from './notify-kim.mjs';

// Existing ORGIAST_USDJPY / budget-fixed.json convention is JPY per USD.
// usdPerJpy is retained as the requested config spelling and uses that same unit.
const FIXED_BUDGET = new URL('./budget-fixed.json', import.meta.url);
export function geminiMonth(now = new Date()) { return new Date(new Date(now).getTime() + 9 * 3600000).toISOString().slice(0, 7); }
export function summarizeGeminiBudget(rows, { now = new Date(), budgetJpy = 50000, usdJpy = 150, ledgerAvailable = true, invalidRows = 0 } = {}) {
  if (!(budgetJpy > 0) || !Number.isFinite(budgetJpy) || !(usdJpy > 0) || !Number.isFinite(usdJpy)) throw new Error('Gemini予算・換算レートは正の数が必要です');
  const month = geminiMonth(now);
  let spentUsd = 0, unmeasuredCalls = 0, totalCalls = 0;
  for (const row of rows) {
    if (row?.provider !== 'gemini') continue;
    const time = Date.parse(row.t);
    if (!Number.isFinite(time)) { invalidRows++; continue; }
    if (geminiMonth(time) !== month || time > new Date(now).getTime()) continue;
    totalCalls++;
    const known = typeof row.usd === 'number' && Number.isFinite(row.usd) && row.usd >= 0;
    if (known) spentUsd += row.usd;
    if (!known || row.estimated === true || row.pricing === 'unknown') unmeasuredCalls++;
  }
  const spentJpy = spentUsd * usdJpy, pct = spentJpy / budgetJpy * 100;
  const jst = new Date(new Date(now).getTime() + 9 * 3600000);
  const days = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 0)).getUTCDate();
  const paceEomJpy = spentJpy / Math.max(1, jst.getUTCDate()) * days;
  const level = !ledgerAvailable || invalidRows > 0 || totalCalls === 0 || unmeasuredCalls / totalCalls > 0.2
    ? 'unknown' : pct > 85 ? 'critical' : pct >= 60 ? 'warn' : 'ok';
  return { month, spentUsd, spentJpy, budgetJpy, pct, unmeasuredCalls, paceEomJpy, level, totalCalls, ledgerAvailable, invalidRows, checkedAt: new Date(now).toISOString() };
}

function readJson(file, fsImpl, fallback) {
  try { return JSON.parse(fsImpl.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function writeJson(file, value, fsImpl) {
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try { fsImpl.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`); fsImpl.renameSync(temp, file); }
  finally { try { fsImpl.unlinkSync(temp); } catch {} }
}
export function formatGeminiBudgetStatus(status, { now = new Date(), unmeasuredCalls = 0 } = {}) {
  if (!status || status.month !== geminiMonth(now) || !['spentUsd', 'spentJpy', 'budgetJpy', 'pct', 'unmeasuredCalls'].every((key) => typeof status[key] === 'number' && Number.isFinite(status[key]))) return `- Gemini 従量: 未計測あり（当月の予算状態なし・不正。利用余裕は判断不能）${unmeasuredCalls > 0 ? ` / うち未計測 ${unmeasuredCalls} 件（実費はこれより大きい）` : ''}`;
  const missing = status.unmeasuredCalls > 0 ? ` / うち未計測 ${status.unmeasuredCalls} 件（実費はこれより大きい）` : '';
  const stale = !Number.isFinite(Date.parse(status.checkedAt)) || new Date(now) - Date.parse(status.checkedAt) > 36 * 3600000;
  return `- Gemini 従量: 台帳計測分 $${status.spentUsd.toFixed(2)}（≒¥${Math.round(status.spentJpy).toLocaleString('ja-JP')}） / 月予算¥${status.budgetJpy.toLocaleString('ja-JP')} に対し ${status.pct.toFixed(1)}% / ${stale ? 'unknown（予算状態が古い）' : status.level}${missing}${status.level === 'unknown' ? ' / 未計測あり・実費総額と利用余裕は判断不能' : ''}`;
}

export async function runGeminiBudgetGuard({ home = geminiHome(), now = new Date(), dryRun = false, fsImpl = fs, notifyImpl = notifyKim } = {}) {
  const dir = path.join(home, '.claude');
  const config = readJson(path.join(dir, 'gemini-budget.json'), fsImpl, {});
  if (!object(config)) throw new Error('gemini-budget.json はJSONオブジェクトが必要です');
  const fixed = readJson(FIXED_BUDGET, fsImpl, {});
  const usdJpy = Number(config.usdPerJpy ?? config.usdJpy ?? process.env.ORGIAST_USDJPY ?? fixed.usdJpy ?? 150);
  let ledgerAvailable = true, invalidRows = 0, text = '';
  try { text = fsImpl.readFileSync(path.join(dir, 'executor-usage.jsonl'), 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; ledgerAvailable = false; }
  const rows = [];
  for (const line of text.split(/\r?\n/).filter((line) => line.trim())) {
    try { const row = JSON.parse(line); if (!object(row)) invalidRows++; else rows.push(row); } catch { invalidRows++; }
  }
  const status = summarizeGeminiBudget(rows, { now, budgetJpy: Number(config.budgetJpy ?? 50000), usdJpy, ledgerAvailable, invalidRows });
  if (dryRun) return status;
  writeJson(path.join(dir, 'gemini-budget-status.json'), status, fsImpl);
  // Known spending alone can exceed budget even when the headline level is unknown.
  if (status.pct > 85) {
    const file = path.join(dir, 'routing-overrides.json');
    const state = readJson(file, fsImpl, {});
    if (!object(state) || (state.demote !== undefined && !object(state.demote))) throw new Error('routing-overrides.json 不正: 既存データを保持して中止');
    const jst = new Date(new Date(now).getTime() + 9 * 3600000);
    const until = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 1) - 9 * 3600000).toISOString();
    state.demote = { ...state.demote, gemini: Date.parse(state.demote?.gemini) > Date.parse(until) ? state.demote.gemini : until };
    writeJson(file, state, fsImpl);
  }
  if (status.level !== 'ok') {
    const result = await notifyImpl(`Gemini 月次予算警告\n${formatGeminiBudgetStatus(status, { now })}\n月末ペース（計測分）: ¥${Math.round(status.paceEomJpy).toLocaleString('ja-JP')}`, { home, webhookFallback: false });
    if (result?.delivered !== 'dm') throw new Error(`Gemini予算警告DM未送信: ${result?.reason || '配信失敗'}`);
  }
  return status;
}
if (isEntry(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) throw new Error('usage: gemini-budget-guard.mjs [--dry-run]');
    console.log(JSON.stringify(await runGeminiBudgetGuard({ dryRun: process.argv.includes('--dry-run') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
