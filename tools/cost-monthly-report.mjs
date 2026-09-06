#!/usr/bin/env node
// cost-monthly-report.mjs — 毎月1日の日次ループ実行時に、前月の確定コスト・委譲率平均・headlessClaude出力・
// 適用した提案と効果を1通のDMにまとめる(仕様C4)。失敗しても日次ループ本体を止めない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COST_PER_MILLION } from './llm-fallback.mjs';
import { summarizeGeminiMonth } from './cost-work-loop.mjs';
import { collectClaudeStats } from './usage-stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONFIG = path.join(HERE, 'budget-fixed.json');

export function jstMonthKey(now) {
  const jst = new Date(new Date(now).getTime() + 9 * 60 * 60 * 1000);
  return `${jst.getUTCFullYear()}-${String(jst.getUTCMonth() + 1).padStart(2, '0')}`;
}

export function isFirstDayOfMonthJst(now) {
  const jst = new Date(new Date(now).getTime() + 9 * 60 * 60 * 1000);
  return jst.getUTCDate() === 1;
}

function prevMonthBounds(now) {
  const jst = new Date(new Date(now).getTime() + 9 * 60 * 60 * 1000);
  const year = jst.getUTCFullYear();
  const monthIndex = jst.getUTCMonth(); // 0-based
  const start = new Date(Date.UTC(year, monthIndex - 1, 1));
  const end = new Date(Date.UTC(year, monthIndex, 1));
  return { key: `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, '0')}`, start, end };
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function readLedger(home) {
  try {
    return fs.readFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), 'utf8').split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  } catch { return []; }
}

export function previousMonthBudget({ home, now = new Date(), configFile = DEFAULT_CONFIG, usdJpy = 150 } = {}) {
  const bounds = prevMonthBounds(now);
  const rows = readLedger(home).filter((row) => {
    const t = Date.parse(row.t || '');
    return Number.isFinite(t) && t >= bounds.start.getTime() && t < bounds.end.getTime();
  });
  let variableUsd = 0;
  for (const row of rows) {
    if (row.provider === 'gemini') continue;
    const price = COST_PER_MILLION[row.provider];
    if (price) variableUsd += ((Number(row.in) || 0) * price[0] + (Number(row.out) || 0) * price[1]) / 1e6;
  }
  const gemini = summarizeGeminiMonth(rows, { now: bounds.end, usdJpy });
  const config = readJson(configFile, { fixed: [] });
  let fixedJpy = 0;
  const fixedNames = [];
  for (const item of config.fixed || []) {
    if (item.kind === 'cap') continue;
    const jpy = item.jpy == null && item.usd != null ? Number(item.usd) * Number(config.usdJpy || usdJpy) : Number(item.jpy);
    if (Number.isFinite(jpy)) { fixedJpy += jpy; fixedNames.push(item.name); }
  }
  const variableJpy = variableUsd * Number(config.usdJpy || usdJpy) + gemini.totalJpy;
  return { month: bounds.key, fixedJpy, variableJpy, totalJpy: fixedJpy + variableJpy, fixedNames, geminiSearches: gemini.searches, executorUsd: variableUsd, usdJpy: Number(config.usdJpy || usdJpy) };
}

export function previousMonthDelegationAverage({ home, now = new Date() } = {}) {
  const bounds = prevMonthBounds(now);
  const prefix = bounds.key;
  const state = readJson(path.join(home, '.claude', 'cost-loop-state.json'), { history: [] });
  const entries = (Array.isArray(state.history) ? state.history : []).filter((h) => String(h.date || '').startsWith(prefix));
  if (!entries.length) return null;
  const values = entries.map((h) => Number(h.nonClaudeDelegRatio ?? h.delegRatio)).filter((v) => Number.isFinite(v));
  if (!values.length) return null;
  return { average: values.reduce((a, b) => a + b, 0) / values.length, days: values.length };
}

// headlessClaudeOut は日別履歴が無いため、前月の全日を含む最近 N 日(前月日数+当月経過日)の合計を近似値として出す。
export function approximatePreviousMonthHeadlessClaudeOut({ home, now = new Date() } = {}) {
  const bounds = prevMonthBounds(now);
  const days = Math.max(28, Math.round((now.getTime() - bounds.start.getTime()) / 86400000));
  try {
    const stats = collectClaudeStats({ home, days, now: now.getTime() });
    return { outputTok: Number(stats.headlessClaudeOut) || 0, days };
  } catch {
    return { outputTok: 0, days };
  }
}

export function appliedActionsSummary({ home, now = new Date() } = {}) {
  const bounds = prevMonthBounds(now);
  const state = readJson(path.join(home, '.claude', 'cost-improve-state.json'), { actions: [] });
  const acts = (Array.isArray(state.actions) ? state.actions : []).filter((act) => {
    const t = Date.parse(act.dispatchedAt || '');
    return Number.isFinite(t) && t >= bounds.start.getTime() && t < bounds.end.getTime();
  });
  const auto = acts.filter((a) => a.mode && a.mode !== 'human');
  const human = acts.filter((a) => a.mode === 'human');
  const weekly = acts.filter((a) => a.source === 'cost-weekly' || a.mode === 'auto-weekly');
  const results = acts.filter((a) => ['worked', 'no_effect', 'worse'].includes(a.result));
  const worked = results.filter((a) => a.result === 'worked').length;
  const lines = [
    `- 自動対処(日次/週次): ${auto.length}件 / 人対応: ${human.length}件 / うち週次提案: ${weekly.length}件`,
    `- 効果検証済み ${results.length}件(内 worked ${worked}件 / no_effect・worse ${results.length - worked}件)`,
  ];
  const recentWeekly = weekly.slice(-5).map((a) => `${a.proposalTitle || a.kind}: ${a.result}`);
  if (recentWeekly.length) lines.push(`- 週次提案の内訳: ${recentWeekly.join(' / ')}`);
  return lines.join('\n');
}

export function buildMonthlyReport({ home = process.env.ORGIAST_HOME || os.homedir(), now = new Date() } = {}) {
  const bounds = prevMonthBounds(now);
  const budget = previousMonthBudget({ home, now });
  const deleg = previousMonthDelegationAverage({ home, now });
  const headless = approximatePreviousMonthHeadlessClaudeOut({ home, now });
  const actions = appliedActionsSummary({ home, now });
  const yen = (n) => `¥${Math.round(n).toLocaleString('ja-JP')}`;
  return `**📆 前月(${bounds.key})コスト月次レポート**\n\n` +
    `### ① 確定コスト(前月)\n` +
    `- 固定 ${yen(budget.fixedJpy)}${budget.fixedNames.length ? ` (${budget.fixedNames.join(', ')})` : ''} / 変動 ${yen(budget.variableJpy)} / 合計 ${yen(budget.totalJpy)}\n` +
    `- 内訳: 安いAI実行者 $${budget.executorUsd.toFixed(2)} / Gemini従量 ${yen(budget.variableJpy - budget.executorUsd * budget.usdJpy)}（検索${budget.geminiSearches}回含む）\n\n` +
    `### ② 委譲率(前月平均)\n` +
    `- ${deleg ? `Claude以外への委譲率平均 ${(deleg.average * 100).toFixed(1)}%（${deleg.days}日分の実測平均）` : 'データなし(直近28日履歴に前月分が無い)'}\n\n` +
    `### ③ headlessClaude出力(前月 近似)\n` +
    `- 無人ジョブの Claude 課金 tier 出力 約 ${(headless.outputTok / 1000).toFixed(0)}k tok（直近${headless.days}日合計）\n\n` +
    `### ④ 適用した提案と効果(前月)\n` +
    `${actions}\n`;
}

export async function shouldSendMonthlyReport({ home, now = new Date(), claudeDir }) {
  if (!isFirstDayOfMonthJst(now)) return false;
  const marker = readJson(path.join(claudeDir, 'cost-monthly-report.json'), {});
  const current = jstMonthKey(now);
  return marker.lastSentMonth !== current;
}

export async function markMonthlyReportSent({ home, now = new Date(), claudeDir }) {
  const file = path.join(claudeDir, 'cost-monthly-report.json');
  const marker = readJson(file, {});
  marker.lastSentMonth = jstMonthKey(now);
  marker.lastSentAt = now.toISOString();
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
}

export async function main(argv = process.argv.slice(2)) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const now = new Date();
  const claudeDir = path.join(home, '.claude');
  const dryRun = argv.includes('--dry-run');
  const text = buildMonthlyReport({ home, now });
  if (argv.includes('--json')) { console.log(JSON.stringify({ ok: true, report: text, shouldSend: await shouldSendMonthlyReport({ home, now, claudeDir }) }, null, 2)); return 0; }
  console.log(text);
  if (!dryRun && await shouldSendMonthlyReport({ home, now, claudeDir })) {
    const { notifyKim } = await import('./notify-kim.mjs');
    try {
      const result = await notifyKim(text, { home, webhookFallback: false });
      if (result?.delivered === 'dm') { await markMonthlyReportSent({ home, now, claudeDir }); console.log('kim へ DM 送信OK'); }
      else throw new Error(result?.reason || 'DM に配信されませんでした');
    } catch (error) {
      console.error(`月次レポートDM送信失敗: ${String(error?.message ?? error)}`);
    }
  }
  return 0;
}

import { isEntry } from './is-entry.mjs';
if (isEntry(import.meta.url)) process.exitCode = await main(process.argv.slice(2));
