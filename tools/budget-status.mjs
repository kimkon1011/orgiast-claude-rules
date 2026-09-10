#!/usr/bin/env node
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs'; import { parseEnvText } from './env-kv.mjs'; import { COST_PER_MILLION } from './llm-fallback.mjs'; import { summarizeGeminiMonth } from './cost-work-loop.mjs'; import { fetchAdminCostReport } from './cost-report.mjs';
const DEFAULT_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'budget-fixed.json');
export function calculateBudgetStatus({ config, ledgerRows = [], developerPlatform = { available: false, reason: '計測不能' }, now = new Date() }) {
  const usdJpy = Number(config.usdJpy) || 0, monthlyBudgetJpy = Number(config.monthlyBudgetJpy) || 0, unfilled = [], fixedItems = []; let fixedJpy = 0;
  for (const item of config.fixed || []) { if (item.kind === 'cap') continue; let jpy = item.jpy == null ? (item.usd == null ? null : Number(item.usd) * usdJpy) : Number(item.jpy); if (!Number.isFinite(jpy)) { unfilled.push(item.name); jpy = null; } else fixedJpy += jpy; fixedItems.push({ name: item.name, jpy }); }
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime(), through = now.getTime(); let executorUsd = 0;
  for (const row of ledgerRows) { const time = Date.parse(row.t || ''); if (time < monthStart || time > through || row.provider === 'gemini') continue; const price = COST_PER_MILLION[row.provider]; if (price) executorUsd += ((Number(row.in) || 0) * price[0] + (Number(row.out) || 0) * price[1]) / 1e6; }
  const gemini = summarizeGeminiMonth(ledgerRows, { now, usdJpy });
  const variableKnownJpy = executorUsd * usdJpy + gemini.totalJpy + (developerPlatform.available ? developerPlatform.totalUsd * usdJpy : 0), totalKnownJpy = fixedJpy + variableKnownJpy;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), elapsedDays = Math.max(1, now.getDate()), projectedJpy = totalKnownJpy / elapsedDays * daysInMonth;
  return { month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, monthlyBudgetJpy, usdJpy, fixedJpy, fixedItems, unfilled, variableKnownJpy, totalKnownJpy, budgetUsedPct: monthlyBudgetJpy ? totalKnownJpy / monthlyBudgetJpy * 100 : null, projectedJpy, budgetPacePct: monthlyBudgetJpy ? projectedJpy / monthlyBudgetJpy * 100 : null, sources: { developerPlatform, executorUsd, geminiJpy: gemini.totalJpy, claudeTeamOverage: { available: false, reason: 'APIでは金額取得不能。プラン上限消化率を参照' } } };
}
export async function collectBudgetStatus({ home = process.env.ORGIAST_HOME || os.homedir(), configFile = DEFAULT_CONFIG, now = new Date(), fetchImpl = fetch } = {}) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8')); let ledgerRows = []; try { ledgerRows = fs.readFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), 'utf8').split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch {}
  let env = {}; try { env = parseEnvText(fs.readFileSync(path.join(home, '.claude', 'cost-monitor.env'), 'utf8')); } catch {}
  const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`, developerPlatform = await fetchAdminCostReport({ startingAt: start, adminKey: env.ANTHROPIC_ADMIN_KEY, fetchImpl });
  return calculateBudgetStatus({ config, ledgerRows, developerPlatform, now });
}
export function formatBudgetStatus(s) { const yen = (n) => `¥${Math.round(n).toLocaleString('ja-JP')}`; return [`月次予算: 固定 ${yen(s.fixedJpy)} / 変動MTD ${yen(s.variableKnownJpy)} / 合計 ${yen(s.totalKnownJpy)} (${s.budgetUsedPct?.toFixed(1) ?? '計測不能'}%)`, `日割りペース: 月末 ${yen(s.projectedJpy)} / 予算比 ${s.budgetPacePct?.toFixed(1) ?? '計測不能'}%`, s.unfilled.length ? `未記入: ${s.unfilled.join(', ')}` : '', !s.sources.developerPlatform.available ? `Developer Platform: 計測不能(${s.sources.developerPlatform.reason})` : '', 'Claude Team 上限超過分: 計測不能(APIでは金額取得不能。プラン上限消化率を参照)'].filter(Boolean).join('\n'); }
if (isEntry(import.meta.url)) { const result = await collectBudgetStatus(); console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : formatBudgetStatus(result)); }
