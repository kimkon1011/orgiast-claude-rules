#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { acquireLock, releaseLock } from './lib/single-instance.mjs';
import { notifyKim } from './notify-kim.mjs';

const MINUTE = 60_000;
const ALERT_COOLDOWN_MS = 6 * 60 * MINUTE;
const PROCESS_NAMES = new Set(['node.exe', 'pwsh.exe', 'powershell.exe']);
const FIELD_SEPARATOR = '\x1f';
const LONG_RUNNING_JOB_MAX_AGE_MIN = 12 * 60;
const BATCH_LOCK_MAX_AGE_MS = 8 * 60 * MINUTE;
const LONG_RUNNING_JOBS = new Set([
  'auto-session-launcher.mjs',
  'auto-session.mjs',
  'auto-session-executor.mjs',
  'gsk-login-keeper.mjs',
  'fleet-poller.ps1',
  'fleet-agent.mjs',
  'nightly-batch.ps1',
  'cost-improve-loop.mjs',
  'cost-work-loop.mjs',
  'codex-do.mjs',
  'cheap-code.mjs',
  'process-hygiene.mjs',
]);

function numberAfter(argv, flag, fallback) {
  const index = argv.indexOf(flag);
  if (index < 0) return fallback;
  const value = Number(argv[index + 1]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} は0以上の数値で指定してください`);
  return value;
}

export function parseOptions(argv = process.argv.slice(2)) {
  return {
    kill: argv.includes('--kill'),
    maxAgeMin: numberAfter(argv, '--max-age-min', 120),
    maxBatchAgeMin: numberAfter(argv, '--max-batch-age-min', 240),
    alertThreshold: numberAfter(argv, '--alert-threshold', 10),
  };
}

function targetKind(commandLine) {
  const command = String(commandLine ?? '').replaceAll('/', '\\');
  if (/\b(?:batch-run|eval-harness)\.mjs\b/i.test(command)) return 'batch';
  if (/\bhook-tree-selfheal\.mjs\b/i.test(command)) return 'tool';
  if (/\\\.claude\\hooks\\[^"']+\.(?:mjs|ps1)(?:["'\s]|$)/i.test(command)) return 'hook';
  if (/\\(?:orgiast-main|orgiast-claude-rules|\.claude\\auto-session-repo)\\tools\\[^"']+\.(?:mjs|ps1)(?:["'\s]|$)/i.test(command)) return 'tool';
  return null;
}

function creationTime(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const cim = value.match(/^\/(?:Date\()?(\d+)(?:\))?\/$/);
    return cim ? Number(cim[1]) : Date.parse(value);
  }
  return Number.NaN;
}

function commandBasename(commandLine) {
  const matches = String(commandLine ?? '').match(/[A-Za-z0-9._-]+\.(?:mjs|ps1)/gi);
  return matches?.[0]?.toLowerCase() ?? '';
}

function lockProtectsBatch(processInfo, lock, now) {
  const lockAge = now - Date.parse(lock?.startedAt);
  return Number(lock?.pid) === Number(processInfo.ProcessId ?? processInfo.pid)
    && Number.isFinite(lockAge) && lockAge >= 0 && lockAge <= BATCH_LOCK_MAX_AGE_MS;
}

export function classifyDetailed(processes, now = Date.now(), opts = {}) {
  const maxAgeMin = opts.maxAgeMin ?? 120;
  const maxBatchAgeMin = opts.maxBatchAgeMin ?? 240;
  const rows = Array.isArray(processes) ? processes : processes ? [processes] : [];
  const livePids = new Set(rows.map((processInfo) => Number(processInfo.ProcessId ?? processInfo.pid)).filter(Number.isInteger));
  const stats = { parentAliveExcluded: 0, longRunningExcluded: 0, lockHeldExcluded: 0 };
  const stale = rows.flatMap((processInfo) => {
    const name = String(processInfo.Name ?? processInfo.name ?? '').toLowerCase();
    if (!PROCESS_NAMES.has(name)) return [];
    const commandLine = String(processInfo.CommandLine ?? processInfo.commandLine ?? '');
    const kind = targetKind(commandLine);
    if (!kind) return [];
    const createdAt = creationTime(processInfo.CreationDate ?? processInfo.creationDate);
    const ageMin = (now - createdAt) / MINUTE;
    const thresholdMin = kind === 'batch' ? maxBatchAgeMin : maxAgeMin;
    if (!Number.isFinite(ageMin) || ageMin <= thresholdMin) return [];
    const parentPid = Number(processInfo.ParentProcessId ?? processInfo.parentPid);
    if (livePids.has(parentPid)) { stats.parentAliveExcluded += 1; return []; }
    const basename = commandBasename(commandLine);
    if (LONG_RUNNING_JOBS.has(basename) && ageMin <= LONG_RUNNING_JOB_MAX_AGE_MIN) {
      stats.longRunningExcluded += 1;
      return [];
    }
    if (basename === 'batch-run.mjs' && lockProtectsBatch(processInfo, opts.batchLock, now)) {
      stats.lockHeldExcluded += 1;
      return [];
    }
    const bytes = Number(processInfo.WorkingSetSize ?? processInfo.workingSetSize ?? 0);
    return [{ pid: Number(processInfo.ProcessId ?? processInfo.pid), name, commandLine, kind, ageMin, mb: Number.isFinite(bytes) ? bytes / 1024 / 1024 : 0 }];
  });
  return { stale, ...stats };
}

export function classify(processes, now = Date.now(), opts = {}) {
  return classifyDetailed(processes, now, opts).stale;
}

export function parseProcessLines(text) {
  const processes = [];
  let totalLines = 0;
  let failedLines = 0;
  for (const rawLine of String(text ?? '').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!rawLine) continue;
    totalLines += 1;
    const fields = rawLine.split(FIELD_SEPARATOR);
    if (fields.length < 6) { failedLines += 1; continue; }
    const [pidText, parentPidText, creationDate, workingSetText, name, ...commandParts] = fields;
    const ProcessId = Number(pidText);
    const ParentProcessId = Number(parentPidText);
    const WorkingSetSize = Number(workingSetText);
    if (!Number.isInteger(ProcessId) || ProcessId < 0
      || !Number.isInteger(ParentProcessId) || ParentProcessId < 0
      || !Number.isFinite(WorkingSetSize) || WorkingSetSize < 0
      || !name || !Number.isFinite(Date.parse(creationDate))) {
      failedLines += 1;
      continue;
    }
    processes.push({ ProcessId, ParentProcessId, CreationDate: creationDate, WorkingSetSize, Name: name, CommandLine: commandParts.join(FIELD_SEPARATOR) });
  }
  return { processes, totalLines, failedLines };
}

function powershellProcesses(spawnImpl = spawnSync) {
  const command = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$separator=[char]31
Get-CimInstance Win32_Process | ForEach-Object {
  $commandLine=[string]$_.CommandLine
  $commandLine=$commandLine.Replace([char]13,' ').Replace([char]10,' ')
  $fields=@([string]$_.ProcessId,[string]$_.ParentProcessId,$_.CreationDate.ToUniversalTime().ToString('o'),[string]$_.WorkingSetSize,[string]$_.Name,$commandLine)
  [Console]::Out.WriteLine(($fields -join $separator))
}`;
  const result = spawnImpl('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  if (result.error || result.status !== 0) throw result.error || new Error(String(result.stderr || `PowerShell exit ${result.status}`).trim());
  return parseProcessLines(result.stdout);
}

function isTarget(processInfo) {
  const name = String(processInfo.Name ?? processInfo.name ?? '').toLowerCase();
  const commandLine = String(processInfo.CommandLine ?? processInfo.commandLine ?? '');
  return PROCESS_NAMES.has(name) && targetKind(commandLine) !== null;
}

function readBatchLock(home) {
  try { return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'locks', 'batch-run.lock'), 'utf8')); }
  catch { return null; }
}

function totalMb(items) { return items.reduce((sum, item) => sum + item.mb, 0); }
function summary(items) { return `${items.length}本 / ${totalMb(items).toFixed(1)} MB`; }

function stopProcesses(items, spawnImpl = spawnSync) {
  if (!items.length) return [];
  const pids = items.map((item) => item.pid).filter((pid) => Number.isInteger(pid) && pid > 0);
  const command = `$ids=@(${pids.join(',')});$failed=@();foreach($id in $ids){try{Stop-Process -Id $id -Force -ErrorAction Stop}catch{$failed+=$id}};$failed|ConvertTo-Json -Compress`;
  const result = spawnImpl('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
  if (result.error || result.status !== 0) throw result.error || new Error(String(result.stderr || `PowerShell exit ${result.status}`).trim());
  const output = String(result.stdout ?? '').trim();
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).map(Number);
}

function appendLog(home, before, after) {
  const file = path.join(home, '.claude', 'logs', 'process-hygiene.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${new Date().toISOString()} before=${summary(before)} after=${summary(after)}\n`);
}

async function maybeAlert(items, threshold, home, now = Date.now(), notify = notifyKim) {
  if (items.length < threshold) return false;
  const stateFile = path.join(home, '.claude', 'state', 'process-hygiene.last-alert');
  let previous = Number.NaN;
  try { previous = Date.parse(fs.readFileSync(stateFile, 'utf8').trim()); } catch {}
  if (Number.isFinite(previous) && now - previous < ALERT_COOLDOWN_MS) return false;
  const result = await notify(`🚨 process-hygiene: hook/バッチ由来の残留を ${summary(items)} 検知しました。`, { home });
  if (result?.delivered === 'none') return false;
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${new Date(now).toISOString()}\n`);
  return true;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const opts = parseOptions(argv);
  if ((deps.platform ?? process.platform) !== 'win32') { console.log('process-hygiene: Windows以外では対象なし (0本 / 0.0 MB)'); return 0; }
  const lock = acquireLock('process-hygiene');
  if (!lock.acquired) { console.log(`process-hygiene: already running${lock.ownerPid ? ` (pid=${lock.ownerPid})` : ''}`); return 0; }
  try {
    const home = deps.home ?? process.env.ORGIAST_HOME ?? os.homedir();
    const query = (deps.listProcesses ?? (() => powershellProcesses(deps.spawnImpl)))();
    const parsed = Array.isArray(query) ? { processes: query, totalLines: query.length, failedLines: 0 } : query;
    const processes = parsed.processes ?? [];
    const now = deps.now ?? Date.now();
    const classified = classifyDetailed(processes, now, { ...opts, batchLock: deps.batchLock ?? readBatchLock(home) });
    const stale = classified.stale;
    const candidates = processes.filter(isTarget).length;
    console.log(`process-hygiene: 照会=${parsed.totalLines ?? processes.length} パース失敗=${parsed.failedLines ?? 0} 対象候補=${candidates} 親生存除外=${classified.parentAliveExcluded} 長時間ジョブ除外=${classified.longRunningExcluded} ロック保持除外=${classified.lockHeldExcluded} 残留判定=${stale.length}`);
    console.log(`process-hygiene: ${opts.kill ? 'kill' : 'dry-run'} ${summary(stale)}`);
    for (const item of stale) console.log(`pid=${item.pid} age=${item.ageMin.toFixed(0)}min mb=${item.mb.toFixed(1)} ${item.commandLine}`);
    if (opts.kill) {
      await maybeAlert(stale, opts.alertThreshold, home, now, deps.notify ?? notifyKim);
      const failed = (deps.stopProcesses ?? ((items) => stopProcesses(items, deps.spawnImpl)))(stale);
      const after = stale.filter((item) => failed.includes(item.pid));
      appendLog(home, stale, after);
      console.log(`process-hygiene: after ${summary(after)}`);
    }
    return 0;
  } finally { releaseLock('process-hygiene'); }
}

if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { console.error(`process-hygiene: ${error.message}`); process.exitCode = 1; }
}
