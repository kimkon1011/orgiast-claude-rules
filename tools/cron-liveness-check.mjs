#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const DAY_MS = 864e5;

export function evaluate(entries, lastSuccessByKey, nowMs) {
  return entries.map((entry) => {
    const key = `${entry.repo}#${entry.workflow}`;
    const raw = lastSuccessByKey[key];
    let lastSuccess = raw ?? null;
    let ageDays = null;
    let status;
    if (raw === undefined) status = 'unknown';
    else if (raw === null) status = 'never';
    else {
      const timestamp = Date.parse(raw);
      if (!Number.isFinite(timestamp)) {
        lastSuccess = null;
        status = 'never';
      } else {
        ageDays = Math.max(0, (nowMs - timestamp) / DAY_MS);
        status = ageDays > entry.everyDays * 1.5 ? 'stale' : 'ok';
      }
    }

    const days = ageDays === null ? null : Math.floor(ageDays);
    let line;
    if (status === 'unknown') line = `⚠️ ${entry.label}: schedule の成功履歴を取得できません`;
    else if (status === 'never') line = `🚨 ${entry.label}: schedule の成功履歴なし`;
    else if (status === 'stale') line = `🚨 ${entry.label}: schedule の最終成功 ${lastSuccess.slice(0, 10)} (${days}日前)`;
    else line = `✅ ${entry.label}: schedule の最終成功 ${lastSuccess.slice(0, 10)} (${days}日前)`;
    return { key, label: entry.label, lastSuccess, ageDays, status, line };
  });
}

export function evaluateGateSkips(records, nowMs) {
  const recent = records.filter((record) => {
    const timestamp = Date.parse(record?.ts || '');
    return Number.isFinite(timestamp) && timestamp >= nowMs - 7 * DAY_MS && timestamp <= nowMs;
  });
  if (recent.length < 3) return null;
  return { key: 'local#handoff-gate-skips', label: 'gate判定スキップ', lastSuccess: null, ageDays: null, status: 'alert', line: `🚨 gate判定スキップ ${recent.length}件（強制が効いていない可能性）` };
}

function fetchLastSuccess(entry) {
  const result = spawnSync('gh', [
    'run', 'list', '--repo', entry.repo, '--workflow', entry.workflow,
    '--event=schedule', '--status', 'success', '--limit', '1', '--json', 'updatedAt',
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (result.error || result.status !== 0) return undefined;
  try {
    const runs = JSON.parse(result.stdout);
    return Array.isArray(runs) && runs.length ? runs[0]?.updatedAt ?? null : null;
  } catch {
    return undefined;
  }
}

function main() {
  const toolsDir = path.dirname(fileURLToPath(import.meta.url));
  const entries = JSON.parse(fs.readFileSync(path.join(toolsDir, 'cron-watch.json'), 'utf8'));
  const lastSuccessByKey = {};
  for (const entry of entries) lastSuccessByKey[`${entry.repo}#${entry.workflow}`] = fetchLastSuccess(entry);
  const nowMs = Date.now();
  const results = evaluate(entries, lastSuccessByKey, nowMs);
  const home = process.env.ORGIAST_HOME || os.homedir();
  const outputDir = path.join(home, '.claude');
  const complianceState = path.join(outputDir, 'rule-compliance-state.json');
  let complianceLastRun = null;
  try { complianceLastRun = JSON.parse(fs.readFileSync(complianceState, 'utf8')).lastRunAt || null; } catch { }
  const complianceAge = complianceLastRun ? (nowMs - Date.parse(complianceLastRun)) / DAY_MS : Infinity;
  results.push({ key: 'local#rule-compliance-loop', label: 'ルール遵守監査', lastSuccess: complianceLastRun, ageDays: complianceAge, status: complianceAge >= 2 ? (complianceLastRun ? 'stale' : 'never') : 'ok', line: complianceAge >= 2 ? `🚨 ルール遵守監査: ${complianceLastRun ? `最終実行 ${complianceLastRun.slice(0, 10)}` : '実行記録なし'}` : `✅ ルール遵守監査: 最終実行 ${complianceLastRun.slice(0, 10)}` });
  let skipRecords = [];
  try { skipRecords = fs.readFileSync(path.join(outputDir, 'handoff-gate-skips.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { }
  const skipAlert = evaluateGateSkips(skipRecords, nowMs);
  if (skipAlert) results.push(skipAlert);
  try {
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, 'cron-liveness.json'), JSON.stringify({ t: new Date(nowMs).toISOString(), results }, null, 2));
  } catch { }
  for (const result of results) console.log(result.line);
  process.exitCode = results.some((result) => result.status === 'stale' || result.status === 'never' || result.status === 'alert') ? 1 : 0;
}

if (isEntry(import.meta.url)) main();
