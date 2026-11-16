#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { geminiHome, loadGeminiPricing } from './gemini-usage-ledger.mjs';
import { notifyKim } from './notify-kim.mjs';

// Existing ORGIAST_USDJPY / budget-fixed.json convention is JPY per USD.
// usdPerJpy is retained as the requested config spelling and uses that same unit.
const FIXED_BUDGET = new URL('./budget-fixed.json', import.meta.url);
export function geminiMonth(now = new Date()) { return new Date(new Date(now).getTime() + 9 * 3600000).toISOString().slice(0, 7); }
export function calcSessionCost({ model, input, output, cached }, pricing = {}, now = new Date()) {
  if (typeof model !== 'string' || !model) return null;
  const rate = pricing?.models?.[model];
  const valid = (!pricing.validThrough || new Date(now).toISOString().slice(0, 10) <= pricing.validThrough)
    && typeof rate?.inputUsdPerMillion === 'number' && Number.isFinite(rate.inputUsdPerMillion) && rate.inputUsdPerMillion >= 0
    && typeof rate?.outputUsdPerMillion === 'number' && Number.isFinite(rate.outputUsdPerMillion) && rate.outputUsdPerMillion >= 0;
  if (!valid) return null;
  const i = Number.isFinite(input) && input >= 0 ? input : 0;
  const o = Number.isFinite(output) && output >= 0 ? output : 0;
  const c = Number.isFinite(cached) && cached >= 0 ? cached : 0;
  const ci = typeof rate.cachedInputUsdPerMillion === 'number' && Number.isFinite(rate.cachedInputUsdPerMillion) && rate.cachedInputUsdPerMillion >= 0
    ? rate.cachedInputUsdPerMillion : 0;
  return ((i - c) * rate.inputUsdPerMillion + c * ci + o * rate.outputUsdPerMillion) / 1e6;
}
export function collectSessionLogUsage({ home = geminiHome(), fsImpl = fs, now = new Date() } = {}) {
  const month = geminiMonth(now);
  const results = []; // { project, model, input, output, cached, sessionId }
  const root = path.join(home, '.gemini', 'tmp');
  let projects;
  try { projects = fsImpl.readdirSync(root, { withFileTypes: true }); } catch { return results; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const projectName = project.name;
    const chats = path.join(root, projectName, 'chats');
    let files;
    try { files = fsImpl.readdirSync(chats, { withFileTypes: true }); } catch { continue; }
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const sessionFileMatch = entry.name.match(/^session-(.+)\.jsonl$/);
      const sessionId = sessionFileMatch ? sessionFileMatch[1] : entry.name;
      const file = path.join(chats, entry.name);
      let lines;
      try { lines = fsImpl.readFileSync(file, 'utf8').split(/\r?\n/); } catch { continue; }
      for (const line of lines) {
        if (!line.trim()) continue;
        let row;
        try { row = JSON.parse(line); } catch { continue; }
        if (row?.type !== 'gemini' || !row.tokens) continue;
        const ts = Date.parse(row.timestamp);
        if (!Number.isFinite(ts)) continue;
        if (geminiMonth(new Date(ts)) !== month) continue;
        const input = Number.isSafeInteger(row.tokens.input) && row.tokens.input >= 0 ? row.tokens.input : null;
        const output = Number.isSafeInteger(row.tokens.output) && row.tokens.output >= 0 ? row.tokens.output : null;
        const cached = Number.isSafeInteger(row.tokens.cached) && row.tokens.cached >= 0 ? row.tokens.cached : null;
        const model = typeof row.model === 'string' && row.model ? row.model : null;
        if (input === null || output === null || model === null) continue;
        results.push({ project: projectName, model, input, output, cached: cached ?? 0, sessionId });
      }
    }
  }
  return results;
}
export function summarizeGeminiBudget(rows, { now = new Date(), budgetJpy = 50000, usdJpy = 150, ledgerAvailable = true, invalidRows = 0, sessionLogRows = [], pricing = {} } = {}) {
  if (!(budgetJpy > 0) || !Number.isFinite(budgetJpy) || !(usdJpy > 0) || !Number.isFinite(usdJpy)) throw new Error('Gemini予算・換算レートは正の数が必要です');
  const month = geminiMonth(now);
  let spentUsd = 0, unmeasuredCalls = 0, totalCalls = 0, sessionInvalidRows = 0;
  const byProject = {};
  // Collect sessionIds from ledger for dedup
  const ledgerSessionIds = new Set();
  for (const row of rows) {
    if (row?.provider !== 'gemini') continue;
    const time = Date.parse(row.t);
    if (!Number.isFinite(time)) { invalidRows++; continue; }
    if (geminiMonth(time) !== month || time > new Date(now).getTime()) continue;
    if (/^http_[45]\d\d$/.test(row.status)) continue;
    totalCalls++;
    const known = typeof row.usd === 'number' && Number.isFinite(row.usd) && row.usd >= 0;
    if (known) spentUsd += row.usd;
    if (!known || row.estimated === true || row.pricing === 'unknown') unmeasuredCalls++;
    // Collect sessionId/toolUseId for dedup with session logs
    for (const idField of ['sessionId', 'session', 'toolUseId']) {
      if (typeof row[idField] === 'string' && row[idField]) { ledgerSessionIds.add(row[idField]); break; }
    }
    if (known) {
      // Track byProject from ledger if available
      const proj = row.project || row.source || 'ledger';
      byProject[proj] = (byProject[proj] || 0) + row.usd;
    }
  }
  // Process session log rows, dedup by sessionId
  const seenSessionIds = new Set();
  let sessionSessionCount = 0, unmeasuredSessionCalls = 0;
  const byProjectSession = {};
  for (const sl of sessionLogRows) {
    if (!sl || !sl.model) { sessionInvalidRows++; continue; }
    // Dedup: skip if already in ledger
    if (sl.sessionId && (ledgerSessionIds.has(sl.sessionId) || seenSessionIds.has(sl.sessionId))) continue;
    if (sl.sessionId) seenSessionIds.add(sl.sessionId);
    const usd = calcSessionCost(sl, pricing, now);
    sessionSessionCount++;
    if (usd !== null && Number.isFinite(usd) && usd >= 0) {
      spentUsd += usd;
      const proj = sl.project || 'unknown';
      byProject[proj] = (byProject[proj] || 0) + usd;
      byProjectSession[proj] = (byProjectSession[proj] || 0) + usd;
    } else {
      unmeasuredSessionCalls++;
    }
  }
  totalCalls += sessionSessionCount;
  unmeasuredCalls += unmeasuredSessionCalls;
  invalidRows += sessionInvalidRows;
  const spentJpy = spentUsd * usdJpy, pct = spentJpy / budgetJpy * 100;
  const jst = new Date(new Date(now).getTime() + 9 * 3600000);
  const days = new Date(Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth() + 1, 0)).getUTCDate();
  const paceEomJpy = spentJpy / Math.max(1, jst.getUTCDate()) * days;
  // Session-logs-aware thresholds: 70% warn, 90% stop/unknown
  const level = !ledgerAvailable || invalidRows > 0 || totalCalls === 0 || unmeasuredCalls / totalCalls > 0.2
    ? 'unknown' : pct > 90 ? 'stop' : pct >= 70 ? 'warn' : 'ok';
  // Sort byProject by USD descending
  const sortedByProject = Object.entries(byProject).sort((a, b) => b[1] - a[1]).map(([k, v]) => ({ project: k, usd: Math.round(v * 100) / 100 }));
  return { month, spentUsd, spentJpy, budgetJpy, pct, unmeasuredCalls, paceEomJpy, level, totalCalls, ledgerAvailable, invalidRows, byProject: sortedByProject, checkedAt: new Date(now).toISOString() };
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
  // Load pricing for session log cost calculation
  const pricing = loadGeminiPricing({ home, fsImpl });
  // Collect session log usage
  let sessionLogRows = [];
  try {
    sessionLogRows = collectSessionLogUsage({ home, fsImpl, now });
  } catch { /* session logs unavailable, proceed without */ }
  const status = summarizeGeminiBudget(rows, { now, budgetJpy: Number(config.budgetJpy ?? 50000), usdJpy, ledgerAvailable, invalidRows, sessionLogRows, pricing });
  if (dryRun) return status;
  writeJson(path.join(dir, 'gemini-budget-status.json'), status, fsImpl);
  // Known spending alone can exceed budget even when the headline level is unknown.
  if (status.pct > 90) {
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
    if (!['dm', 'session-inbox'].includes(result?.delivered)) throw new Error(`Gemini予算警告DM未送信: ${result?.reason || '配信失敗'}`);
  }
  return status;
}
if (isEntry(import.meta.url)) {
  try {
    if (process.argv.slice(2).some((arg) => arg !== '--dry-run')) throw new Error('usage: gemini-budget-guard.mjs [--dry-run]');
    console.log(JSON.stringify(await runGeminiBudgetGuard({ dryRun: process.argv.includes('--dry-run') }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}