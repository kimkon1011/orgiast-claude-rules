#!/usr/bin/env node
import os from 'node:os';
import { COST_PER_MILLION } from './llm-fallback.mjs';
import { readLedger, jstMonthKey } from './cost-monthly-report.mjs';
import { collectClaudeStats, collectCodexUsage } from './usage-stats.mjs';
import { summarizeGeminiMonth } from './cost-work-loop.mjs';
import { isEntry } from './is-entry.mjs';

export function normalizeProvider(value) {
  const name = String(value ?? '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  return ({ GROK: 'XAI', MOONSHOT: 'KIMI', ZAI: 'GLM', Z_AI: 'GLM', CLAUDE: 'ANTHROPIC', CODEX: 'OPENAI', GEMINI_CLI: 'GEMINI' })[name] || name;
}
export function monthWindow(count = 13, now = new Date()) {
  if (!Number.isInteger(count) || count < 1) throw new Error('--months は正の整数が必要です');
  const [year, month] = jstMonthKey(now).split('-').map(Number);
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(year, month - count + i, 1)).toISOString().slice(0, 7));
}
const token = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
export function aggregateExecutor(rows, { jpyPerUsd = 150, months = 13, now = new Date() } = {}) {
  if (!Number.isFinite(jpyPerUsd) || jpyPerUsd <= 0) throw new Error('--jpy-per-usd は正の数が必要です');
  const window = new Set(monthWindow(months, now)), result = {}, gemini = {};
  for (const row of rows) {
    const timestamp = Date.parse(row?.t);
    if (!Number.isFinite(timestamp) || timestamp > +now) continue;
    const month = jstMonthKey(timestamp), provider = normalizeProvider(row.provider);
    if (!window.has(month) || !provider) continue;
    const entry = (result[month] ||= {})[provider] ||= { jpy: 0, inTok: 0, outTok: 0, calls: 0, billing: '従量', estimated: true };
    entry.inTok += token(row.in) ? row.in : 0; entry.outTok += token(row.out) ? row.out : 0; entry.calls++;
    const fixed = ['codex', 'claude', 'gemini-cli'].includes(String(row.provider).toLowerCase());
    const prices = COST_PER_MILLION[String(row.provider).toLowerCase()] || COST_PER_MILLION[provider === 'XAI' ? 'grok' : provider.toLowerCase()];
    if (fixed) { entry.jpy = null; entry.billing = '定額'; continue; }
    if (provider === 'GEMINI') {
      // 計測済usd（検索等も含む）は既存Gemini集計で扱い、旧ログは既存トークン単価で補う。
      const priced = Object.hasOwn(row, 'usd') ? row.usd : prices && token(row.in) && token(row.out) ? (row.in * prices[0] + row.out * prices[1]) / 1e6 : null;
      (gemini[month] ||= []).push({ ...row, provider: 'gemini', usd: priced });
    } else if (entry.jpy !== null) {
      if (!prices || !token(row.in) || !token(row.out)) { entry.jpy = null; entry.billing = '判定不能'; }
      else entry.jpy += (row.in * prices[0] + row.out * prices[1]) / 1e6 * jpyPerUsd;
    }
  }
  for (const [month, records] of Object.entries(gemini)) {
    const [year, number] = month.split('-').map(Number);
    const end = new Date(Math.min(+now, Date.UTC(year, number, 1) - 9 * 3600000 - 1));
    const total = summarizeGeminiMonth(records, { now: end, usdJpy: jpyPerUsd });
    const entry = result[month].GEMINI;
    const unknown = records.some((r) => !token(r.usd) || r.pricing === 'unknown');
    if (entry.billing !== '定額') { entry.jpy = unknown ? null : total.totalJpy; entry.billing = unknown ? '判定不能' : '従量'; }
    entry.searches = total.searches;
  }
  return result;
}
export function collectLocalUsage({ home = process.env.ORGIAST_HOME || os.homedir(), jpyPerUsd = 150, months = 13, now = new Date(), ledger = readLedger, claude = collectClaudeStats, codex = collectCodexUsage } = {}) {
  const result = aggregateExecutor(ledger(home), { jpyPerUsd, months, now });
  const window = monthWindow(months, now), start = Date.parse(`${window[0]}-01T00:00:00+09:00`);
  const options = { home, now: +now, days: (+now - start) / 86400000, monthKey: jstMonthKey };
  for (const [provider, stats] of [['ANTHROPIC', claude(options)], ['OPENAI', codex(options)]]) {
    for (const [month, value] of Object.entries(stats.months || {})) {
      if (!window.includes(month)) continue;
      // transcriptとexecutorの同じ実行を二重加算しない。定額セッションはtranscriptを正とする。
      (result[month] ||= {})[provider] = { jpy: null, inTok: 0, outTok: value.outputTokens, calls: value.calls, billing: '定額', source: 'session-transcript' };
    }
  }
  return { months: result, jpyPerUsd, generatedAt: now.toISOString() };
}
export function parseLocalArgs(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    if (!['--jpy-per-usd', '--months'].includes(args[i]) || !args[i + 1]) throw new Error(`不明な引数: ${args[i]}`);
    options[args[i] === '--months' ? 'months' : 'jpyPerUsd'] = Number(args[++i]);
  }
  return options;
}
if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(collectLocalUsage(parseLocalArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(`ai-usage-local: ${error.message}`); process.exitCode = 1; }
}
