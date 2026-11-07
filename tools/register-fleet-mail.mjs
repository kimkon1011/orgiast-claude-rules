#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { parseEnvText } from './env-kv.mjs';
import { HUB_LABEL } from './fleet-question-relay.mjs';
import { isEntry } from './is-entry.mjs';

export const STALE_POLL_MS = 10 * 60 * 1000;
export const HEALTHY_TASK_RESULTS = Object.freeze([0, 267009, 267011]);
const psLiteral = value => "'" + String(value).replaceAll("'", "''") + "'";
export const probeScript = taskName => [
  `$t = Get-ScheduledTask -TaskName ${psLiteral(taskName)} -ErrorAction SilentlyContinue`,
  "if (-not $t) { 'absent'; exit }",
  "if ($t.State -eq 'Disabled') { 'disabled'; exit }",
  `$i = Get-ScheduledTaskInfo -TaskName ${psLiteral(taskName)} -ErrorAction SilentlyContinue`,
  `if (-not $i -or $i.LastTaskResult -notin @(${HEALTHY_TASK_RESULTS.join(', ')})) { 'failed'; exit }`,
  "'ok'"
].join('; ');

// 'ok' / 'absent' / 'disabled' / 'failed' / （失敗時は空文字以外の出力）
export function probeTask(spawnImpl, taskName) {
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', probeScript(taskName)],
    { encoding: 'utf8', windowsHide: true, timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
  return result.error || result.status !== 0 ? 'failed' : String(result.stdout || '').trim();
}
export function fleetMailTasksHealthy(spawnImpl, { watchdog = false } = {}) {
  const tasks = watchdog ? ['OrgiastFleetMail', 'OrgiastFleetMailWatchdog'] : ['OrgiastFleetMail'];
  return tasks.every(task => probeTask(spawnImpl, task) === 'ok');
}
export const MIGRATION_MARKER = '.fleet-mail-v2-migrated';
export function convergeFleetMail({ home, spawnImpl = spawnSync, now = Date.now }) {
  const repo = fileURLToPath(new URL('../', import.meta.url));
  const run = (script, args) => {
    const result = spawnImpl(process.execPath, [path.join(repo, 'tools', script), ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo },
    });
    if (result.error || result.status !== 0) throw new Error('fleet-mail: converge 失敗=1');
  };
  configureFleetHub({ home });
  run('register-hooks.mjs', ['--hooks-only']);
  const marker = path.join(home, '.claude', MIGRATION_MARKER);
  if (!fs.existsSync(marker)) {
    run('fleet-mail.mjs', ['--sweep']);
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, new Date(now()).toISOString() + '\n', { mode: 0o600 });
  }
}
export function fleetHubNeedsConfiguration({ home, label = resolveFleetLabel(home) }) {
  const file = path.join(home, '.claude', 'fleet-sheet.env');
  return fs.existsSync(file) && label !== HUB_LABEL && !Object.hasOwn(parseEnvText(fs.readFileSync(file, 'utf8')), 'FLEET_HUB');
}
export function configureFleetHub({ home, label = resolveFleetLabel(home) }) {
  const file = path.join(home, '.claude', 'fleet-sheet.env');
  if (!fleetHubNeedsConfiguration({ home, label })) return false;
  const text = fs.readFileSync(file, 'utf8');
  if (Object.hasOwn(parseEnvText(text), 'FLEET_HUB')) return false;
  fs.appendFileSync(file, `${text.endsWith('\n') ? '' : '\n'}FLEET_HUB=${HUB_LABEL}\n`, { mode: 0o600 });
  return true;
}
export function pollIsFresh(home, now = Date.now) {
  try { return now() - fs.statSync(path.join(home, '.claude', '.fleet-mail-last-poll.json')).mtimeMs <= STALE_POLL_MS; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export function main({ home = process.env.ORGIAST_HOME || os.homedir(), platform = process.platform, spawnImpl = spawnSync, ensure = false, converge = false, quiet = false, now = Date.now, stdout = console.log } = {}) {
  const envPath = path.join(home, '.claude', 'fleet-sheet.env');
  if (!fs.existsSync(envPath)) return 0;
  if (converge) convergeFleetMail({ home, spawnImpl, now });
  if (platform !== 'win32') return 0;
  // --ensure: 登録状態・実行結果と最後の受信成功時刻を検査する。
  // fleet-poller.ps1 の日次自己修復から冪等に呼ばれる（2026-10-10 cr-PC 受信停止事故の再発防止）。
  if (ensure) {
    let watchdogEnabled = false;
    try { watchdogEnabled = /(^|\r?\n)\s*FLEET_MAIL_WATCHDOG=1/.test(fs.readFileSync(envPath, 'utf8')); }
    catch { /* 読めなければタスク登録側の判定に任せる */ }
    if (fleetMailTasksHealthy(spawnImpl, { watchdog: watchdogEnabled }) && pollIsFresh(home, now)) { if (!quiet) stdout('健全=1'); return 0; }
  }
  const script = fileURLToPath(new URL('./register-fleet-mail.ps1', import.meta.url));
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `register-fleet-mail exit=${result.status}`);
  if (ensure) {
    const poll = spawnImpl(process.execPath, [fileURLToPath(new URL('./fleet-mail.mjs', import.meta.url)), '--poll', '--no-exec'], {
      encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ORGIAST_HOME: home },
    });
    if (poll.error || poll.status !== 0) throw new Error('fleet-mail: 修復後受信失敗=1');
  }
  if (!quiet) stdout('登録=1');
  return 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = main({ ensure: process.argv.includes('--ensure'), quiet: process.argv.includes('--quiet'), converge: process.argv.includes('--converge') }); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
