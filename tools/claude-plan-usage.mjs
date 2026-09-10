#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

export async function fetchClaudePlanUsage({ home = process.env.ORGIAST_HOME || os.homedir(), fetchImpl = fetch } = {}) {
  let credentials;
  try { credentials = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8')); }
  catch (error) { return { available: false, reason: `credentials: ${error.code || error.name}` }; }
  const token = credentials?.claudeAiOauth?.accessToken;
  if (!token) return { available: false, reason: 'accessToken 未設定' };
  try {
    const response = await fetchImpl('https://api.anthropic.com/api/oauth/usage', { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' } });
    if (!response.ok) return { available: false, reason: `HTTP ${response.status}` };
    const json = await response.json(), five = json?.five_hour, seven = json?.seven_day;
    if (!five || !seven || !Number.isFinite(Number(five.utilization)) || !Number.isFinite(Number(seven.utilization))) return { available: false, reason: 'usage response の形式が未対応' };
    const scoped = Array.isArray(json?.limits) ? json.limits
      .filter((limit) => limit?.kind === 'weekly_scoped' || limit?.scope != null)
      .map((limit) => ({
        label: limit.scope?.model?.display_name || limit.scope?.model?.id || limit.scope?.surface || limit.kind,
        percent: Number(limit.percent),
        resetsAt: limit.resets_at || null,
        isActive: Boolean(limit.is_active),
        kind: limit.kind,
      })) : [];
    return { available: true, fiveHour: { utilization: Number(five.utilization), resetsAt: five.resets_at || null }, sevenDay: { utilization: Number(seven.utilization), resetsAt: seven.resets_at || null }, scoped };
  } catch (error) { return { available: false, reason: `network: ${error.name || 'error'}` }; }
}

export function formatClaudePlanUsage(result) {
  if (!result.available) return `Claudeプラン上限: 計測不能(${result.reason})`;
  const scoped = Array.isArray(result.scoped) ? result.scoped : [];
  const scopedText = scoped.map((limit) => ` / ${limit.label}週 ${limit.percent}%`).join('');
  const sevenDayWarning = result.sevenDay.utilization >= 80 ? ' ⚠️ 上限超過→従量課金の手前。監督の応答回数を減らし、実装/調査を Codex・Gemini へ' : '';
  const scopedWarning = scoped.filter((limit) => limit.percent >= 80).map((limit) => ` ⚠️ ${limit.label} 専用枠が先に枯れる。Fable 本体の直接作業をやめ Codex/Sonnet へ委譲(§1.18.1)`).join('');
  return `Claudeプラン上限: 5h ${result.fiveHour.utilization.toFixed(1)}% / 7日 ${result.sevenDay.utilization.toFixed(1)}%${scopedText}${sevenDayWarning}${scopedWarning}`;
}

if (isEntry(import.meta.url)) console.log(process.argv.includes('--json') ? JSON.stringify(await fetchClaudePlanUsage(), null, 2) : formatClaudePlanUsage(await fetchClaudePlanUsage()));
