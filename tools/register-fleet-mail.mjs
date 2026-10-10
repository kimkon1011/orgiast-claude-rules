#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export const STALE_TASK_HOURS = 24;
const probeScript = taskName => [
  `$t = Get-ScheduledTask -TaskName '${taskName}' -ErrorAction SilentlyContinue`,
  "if (-not $t) { 'absent'; exit }",
  "if ($t.State -eq 'Disabled') { 'disabled'; exit }",
  `$i = Get-ScheduledTaskInfo -TaskName '${taskName}' -ErrorAction SilentlyContinue`,
  `if ($i -and $i.LastRunTime -and ((Get-Date) - $i.LastRunTime) -gt [TimeSpan]::FromHours(${STALE_TASK_HOURS})) { 'stale'; exit }`,
  "'ok'"
].join('; ');

// 'ok' / 'absent' / 'disabled' / 'stale' / （失敗時は空文字以外の出力）
export function probeTask(spawnImpl, taskName) {
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', probeScript(taskName)],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return String(result.stdout || '').trim();
}
export function fleetMailTasksHealthy(spawnImpl, { watchdog = false } = {}) {
  const tasks = watchdog ? ['OrgiastFleetMail', 'OrgiastFleetMailWatchdog'] : ['OrgiastFleetMail'];
  return tasks.every(task => probeTask(spawnImpl, task) === 'ok');
}
export function main({ home = process.env.ORGIAST_HOME || os.homedir(), platform = process.platform, spawnImpl = spawnSync, ensure = false } = {}) {
  const envPath = path.join(home, '.claude', 'fleet-sheet.env');
  if (platform !== 'win32' || !fs.existsSync(envPath)) return 0;
  // --ensure: 受信タスクが未登録/Disabled/最終実行が24h以上前のときだけ再登録する。
  // fleet-poller.ps1 の日次自己修復から冪等に呼ばれる（2026-10-10 cr-PC 受信停止事故の再発防止）。
  if (ensure) {
    let watchdogEnabled = false;
    try { watchdogEnabled = /(^|\r?\n)\s*FLEET_MAIL_WATCHDOG=1/.test(fs.readFileSync(envPath, 'utf8')); }
    catch { /* 読めなければタスク登録側の判定に任せる */ }
    if (fleetMailTasksHealthy(spawnImpl, { watchdog: watchdogEnabled })) { console.log('OrgiastFleetMail healthy'); return 0; }
  }
  const script = fileURLToPath(new URL('./register-fleet-mail.ps1', import.meta.url));
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `register-fleet-mail exit=${result.status}`);
  console.log(result.stdout || 'OrgiastFleetMail registered');
  return 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = main({ ensure: process.argv.includes('--ensure') }); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
