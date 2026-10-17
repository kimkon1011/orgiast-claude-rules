#!/usr/bin/env node
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs'; import { parseEnvText } from './env-kv.mjs'; import { COST_PER_MILLION } from './llm-fallback.mjs'; import { summarizeGeminiMonth } from './cost-work-loop.mjs'; import { fetchAdminCostReport } from './cost-report.mjs';
import { readReceiptLedger, summarizeReceipts } from './ai-receipt-scan.mjs';
const DEFAULT_CONFIG = path.join(path.dirname(fileURLToPath(import.meta.url)), 'budget-fixed.json');
export function calculateBudgetStatus({ config, ledgerRows = [], receipts = { anthropicMtdUsd: 0, otherMtdUsd: 0, byVendor: {} }, developerPlatform = { available: false, reason: '計測不能' }, now = new Date() }) {
  const usdJpy = Number(config.usdJpy) || 0, monthlyBudgetJpy = Number(config.monthlyBudgetJpy) || 0, unfilled = [], fixedItems = []; let fixedJpy = 0;
  for (const item of config.fixed || []) { if (item.kind === 'cap') continue; let jpy = item.jpy == null ? (item.usd == null ? null : Number(item.usd) * usdJpy) : Number(item.jpy); if (!Number.isFinite(jpy)) { unfilled.push(item.name); jpy = null; } else fixedJpy += jpy; fixedItems.push({ name: item.name, jpy }); }
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime(), through = now.getTime(); let executorUsd = 0;
  for (const row of ledgerRows) { const time = Date.parse(row.t || ''); if (time < monthStart || time > through || row.provider === 'gemini') continue; const price = COST_PER_MILLION[row.provider]; if (price) executorUsd += ((Number(row.in) || 0) * price[0] + (Number(row.out) || 0) * price[1]) / 1e6; }
  const gemini = summarizeGeminiMonth(ledgerRows, { now, usdJpy });
  const variableKnownJpy = executorUsd * usdJpy + gemini.totalJpy + Math.max(developerPlatform.available ? developerPlatform.totalUsd : 0, receipts.anthropicMtdUsd || 0) * usdJpy, totalKnownJpy = fixedJpy + variableKnownJpy;
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate(), elapsedDays = Math.max(1, now.getDate()), projectedJpy = totalKnownJpy / elapsedDays * daysInMonth;
  return { month: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`, monthlyBudgetJpy, usdJpy, fixedJpy, fixedItems, unfilled, variableKnownJpy, totalKnownJpy, budgetUsedPct: monthlyBudgetJpy ? totalKnownJpy / monthlyBudgetJpy * 100 : null, projectedJpy, budgetPacePct: monthlyBudgetJpy ? projectedJpy / monthlyBudgetJpy * 100 : null, sources: { receipts, developerPlatform, executorUsd, geminiJpy: gemini.totalJpy, claudeTeamOverage: { available: false, reason: 'APIでは金額取得不能。プラン上限消化率を参照' } } };
}
export async function collectBudgetStatus({ home = process.env.ORGIAST_HOME || os.homedir(), configFile = DEFAULT_CONFIG, now = new Date(), fetchImpl = fetch } = {}) {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8')); let ledgerRows = []; try { ledgerRows = fs.readFileSync(path.join(home, '.claude', 'executor-usage.jsonl'), 'utf8').split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch {}
  let env = {}; try { env = parseEnvText(fs.readFileSync(path.join(home, '.claude', 'cost-monitor.env'), 'utf8')); } catch {}
  const month = new Date(now.getTime() + 9 * 3600e3).toISOString().slice(0, 7);
  const start = new Date(`${month}-01T00:00:00+09:00`).toISOString();
  const adminKeys = Object.entries(env).filter(([name, key]) => /^ANTHROPIC_ADMIN_KEY(?:_[A-Za-z0-9_]+)?$/.test(name) && key)
    .map(([name, key]) => ({ label: name === 'ANTHROPIC_ADMIN_KEY' ? 'default' : name.slice('ANTHROPIC_ADMIN_KEY_'.length), key }));
  const developerPlatform = await fetchAdminCostReport({ startingAt: start, adminKeys, fetchImpl });
  const { totals } = summarizeReceipts(readReceiptLedger(home), { now });
  const anthropicMtdUsd = totals.byVendor.anthropic || 0;
  const receipts = { anthropicMtdUsd, otherMtdUsd: totals.mtdUsd - anthropicMtdUsd, byVendor: totals.byVendor };
  return calculateBudgetStatus({ config, ledgerRows, developerPlatform, receipts, now });
}
export function formatBudgetStatus(s) {
  const yen = (n) => `¥${Math.round(n).toLocaleString('ja-JP')}`;
  const platform = s.sources.developerPlatform, receipts = s.sources.receipts;
  const orgs = Object.entries(platform.byOrg || {}).map(([name, value]) => `${name} $${value.totalUsd.toFixed(2)}`).join(' / ');
  return [
    `月次予算: 固定 ${yen(s.fixedJpy)} / 変動MTD ${yen(s.variableKnownJpy)} / 合計 ${yen(s.totalKnownJpy)} (${s.budgetUsedPct?.toFixed(1) ?? '計測不能'}%)`,
    `日割りペース: 月末 ${yen(s.projectedJpy)} / 予算比 ${s.budgetPacePct?.toFixed(1) ?? '計測不能'}%`,
    s.unfilled.length ? `未記入: ${s.unfilled.join(', ')}` : '',
    `領収書(Gmail・全アカウント): Anthropic $${(receipts?.anthropicMtdUsd || 0).toFixed(2)} / その他 $${(receipts?.otherMtdUsd || 0).toFixed(2)}（取得済み領収書のみ）`,
    platform.available ? `Developer Platform: $${platform.totalUsd.toFixed(2)}${orgs ? `（org: ${orgs}）` : ''}` : `Developer Platform: 計測不能(${platform.reason})`,
    ...(platform.errors || []).map(e => `Developer Platform 未計測: ${e.label}（${e.reason}）`),
    'Claude Team 上限超過分: 計測不能(APIでは金額取得不能。プラン上限消化率を参照)',
  ].filter(Boolean).join('\n');
}
if (isEntry(import.meta.url)) { const result = await collectBudgetStatus(); console.log(process.argv.includes('--json') ? JSON.stringify(result, null, 2) : formatBudgetStatus(result)); }
