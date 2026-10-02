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
  const dryRun = argv.includes('--dry-run');
  return {
    kill: argv.includes('--kill') && !dryRun,
    dryRun,
    maxAgeMin: numberAfter(argv, '--max-age-min', 120),
    maxBatchAgeMin: numberAfter(argv, '--max-batch-age-min', 240),
    alertThreshold: numberAfter(argv, '--alert-threshold', 10),
    vscodeIdleMin: numberAfter(argv, '--vscode-idle-min', 180),
  };
}

const TERMINAL_NAMES = new Set(['windowsterminal.exe']);
const CONSOLE_HOST_NAMES = new Set(['conhost.exe', 'openconsole.exe']);

// Windows Terminal 配下に console host はあるが、そこから先にクライアントがいない窓だけを返す。
// Terminal 単体や、系譜を確定できないプロセスは誤終了防止のため対象にしない。
export function classifyOrphanConsoleWindows(processes) {
  const rows = Array.isArray(processes) ? processes : processes ? [processes] : [];
  const children = new Map();
  for (const row of rows) {
    const parentPid = Number(row.ParentProcessId ?? row.parentPid);
    if (!Number.isInteger(parentPid)) continue;
    const siblings = children.get(parentPid) ?? [];
    siblings.push(row);
    children.set(parentPid, siblings);
  }
  const descendants = (pid) => {
    const found = [];
    const pending = [...(children.get(pid) ?? [])];
    const seen = new Set();
    while (pending.length) {
      const row = pending.pop();
      const childPid = Number(row.ProcessId ?? row.pid);
      if (!Number.isInteger(childPid) || seen.has(childPid)) continue;
      seen.add(childPid);
      found.push(row);
      pending.push(...(children.get(childPid) ?? []));
    }
    return found;
  };
  return rows.flatMap((terminal) => {
    const name = String(terminal.Name ?? terminal.name ?? '').toLowerCase();
    if (!TERMINAL_NAMES.has(name)) return [];
    const terminalPid = Number(terminal.ProcessId ?? terminal.pid);
    const tree = descendants(terminalPid);
    const hosts = tree.filter((row) => CONSOLE_HOST_NAMES.has(String(row.Name ?? row.name ?? '').toLowerCase()));
    if (!hosts.length) return [];
    const hostTreePids = new Set(hosts.flatMap((host) => descendants(Number(host.ProcessId ?? host.pid))).map((row) => Number(row.ProcessId ?? row.pid)));
    const clients = tree.filter((row) => {
      const rowName = String(row.Name ?? row.name ?? '').toLowerCase();
      const rowPid = Number(row.ProcessId ?? row.pid);
      return hostTreePids.has(rowPid) && !CONSOLE_HOST_NAMES.has(rowName);
    });
    if (clients.length) return [];
    const bytes = Number(terminal.WorkingSetSize ?? terminal.workingSetSize ?? 0);
    return [{ pid: terminalPid, name, commandLine: String(terminal.CommandLine ?? terminal.commandLine ?? ''), kind: 'orphan-console-window', ageMin: 0, mb: Number.isFinite(bytes) ? bytes / 1024 / 1024 : 0 }];
  });
}

const VSCODE_IDLE_MAX_KILLS = 15;
const START_TIME_TOLERANCE_MS = 2 * MINUTE;

// VSCode 拡張の claude.exe だけを対象にする。WindowsApps の Claude デスクトップアプリは含めない。
export function isVscodeClaude(processInfo) {
  const name = String(processInfo.Name ?? processInfo.name ?? '').toLowerCase();
  const command = String(processInfo.CommandLine ?? processInfo.commandLine ?? '').replaceAll('/', '\\').toLowerCase();
  if (name !== 'claude.exe') return false;
  if (command.includes('\\windowsapps\\claude_')) return false;
  return command.includes('\\.vscode\\extensions\\anthropic.claude-code-') && command.includes('\\native-binary\\claude.exe');
}

// 純粋関数: opts.readSession(pid) -> sessions JSON か null、opts.transcriptMtime(sessionId) -> ms か null。
export function classifyVscodeIdle(processes, now = Date.now(), opts = {}) {
  const idleMin = opts.idleMin ?? 180;
  const max = opts.max ?? VSCODE_IDLE_MAX_KILLS;
  const rows = Array.isArray(processes) ? processes : processes ? [processes] : [];
  if (opts.batchLockActive) return [];
  const found = [];
  for (const processInfo of rows) {
    if (!isVscodeClaude(processInfo)) continue;
    const pid = Number(processInfo.ProcessId ?? processInfo.pid);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    let session = null;
    try { session = opts.readSession?.(pid) ?? null; } catch { session = null; }
    if (!session || typeof session !== 'object') continue;
    if (session.entrypoint !== 'claude-vscode' || session.status === 'busy') continue;
    const activity = Math.max(Number(session.statusUpdatedAt) || 0, Number(session.updatedAt) || 0);
    if (!activity) continue;
    let lastMs = activity;
    let mtime = null;
    try { mtime = session.sessionId ? opts.transcriptMtime?.(session.sessionId) ?? null : null; } catch { mtime = null; }
    if (Number.isFinite(mtime)) lastMs = Math.max(lastMs, mtime);
    const idle = (now - lastMs) / MINUTE;
    if (!(idle >= idleMin)) continue;
    const startedAt = Number(session.startedAt);
    const createdAt = creationTime(processInfo.CreationDate ?? processInfo.creationDate);
    if (!Number.isFinite(startedAt) || !Number.isFinite(createdAt) || Math.abs(createdAt - startedAt) > START_TIME_TOLERANCE_MS) continue;
    const bytes = Number(processInfo.WorkingSetSize ?? processInfo.workingSetSize ?? 0);
    found.push({ pid, name: 'claude.exe', commandLine: String(processInfo.CommandLine ?? processInfo.commandLine ?? ''), kind: 'vscode-claude-idle', sessionId: session.sessionId ?? '', idleMin: idle, ageMin: idle, mb: Number.isFinite(bytes) ? bytes / 1024 / 1024 : 0 });
  }
  return found.sort((a, b) => b.idleMin - a.idleMin).slice(0, max);
}

function readSessionFile(home, pid) {
  try { return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'sessions', `${pid}.json`), 'utf8')); }
  catch { return null; }
}

function findTranscriptMtime(home, sessionId) {
  try {
    if (!/^[0-9a-f-]{8,64}$/i.test(String(sessionId))) return null;
    const root = path.join(home, '.claude', 'projects');
    let best = null;
    for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      try { const m = fs.statSync(path.join(root, dir.name, `${sessionId}.jsonl`)).mtimeMs; if (best === null || m > best) best = m; } catch {}
    }
    return best;
  } catch { return null; }
}

function batchLockActive(lock, processes, now) {
  if (!lock) return false;
  const age = now - Date.parse(lock.startedAt);
  if (!Number.isFinite(age) || age < 0 || age > BATCH_LOCK_MAX_AGE_MS) return false;
  return processes.some((row) => Number(row.ProcessId ?? row.pid) === Number(lock.pid));
}

// 子プロセスツリーごと停止する。
function stopProcessTrees(items, spawnImpl = spawnSync) {
  const failed = [];
  for (const item of items) {
    const result = spawnImpl('taskkill', ['/PID', String(item.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    if (result.error || result.status !== 0) failed.push(item.pid);
  }
  return failed;
}

function appendIdleLog(home, items, now = new Date()) {
  if (!items.length) return;
  const file = path.join(home, '.claude', 'logs', 'process-hygiene-events.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, items.map((item) => `${now.toISOString()} category=vscode-claude-idle pid=${item.pid} sessionId=${item.sessionId} idleMin=${Math.round(item.idleMin)}\n`).join(''));
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
  const file = path.join(home, '.claude', 'logs', 'process-hygiene-events.log');
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
    const orphanWindows = classifyOrphanConsoleWindows(processes);
    const candidates = processes.filter(isTarget).length;
    console.log(`process-hygiene: 照会=${parsed.totalLines ?? processes.length} パース失敗=${parsed.failedLines ?? 0} 対象候補=${candidates} 親生存除外=${classified.parentAliveExcluded} 長時間ジョブ除外=${classified.longRunningExcluded} ロック保持除外=${classified.lockHeldExcluded} 残留判定=${stale.length}`);
    console.log(`process-hygiene: ${opts.kill ? 'kill' : 'dry-run'} ${summary(stale)}`);
    for (const item of stale) console.log(`pid=${item.pid} age=${item.ageMin.toFixed(0)}min mb=${item.mb.toFixed(1)} ${item.commandLine}`);
    console.log(`process-hygiene: orphan-console-windows ${opts.kill ? 'kill' : 'dry-run'} ${summary(orphanWindows)}`);
    for (const item of orphanWindows) console.log(`terminal-pid=${item.pid} mb=${item.mb.toFixed(1)} ${item.commandLine}`);
    const idleClaude = classifyVscodeIdle(processes, now, {
      idleMin: opts.vscodeIdleMin,
      readSession: deps.readSession ?? ((pid) => readSessionFile(home, pid)),
      transcriptMtime: deps.transcriptMtime ?? ((id) => findTranscriptMtime(home, id)),
      batchLockActive: batchLockActive(deps.batchLock ?? readBatchLock(home), processes, now),
    });
    console.log(`process-hygiene: vscode-claude-idle ${opts.kill ? 'kill' : 'dry-run'} 候補=${idleClaude.length}件 (${summary(idleClaude)}, 閾値=${opts.vscodeIdleMin}分)`);
    for (const item of idleClaude) console.log(`category=vscode-claude-idle pid=${item.pid} sessionId=${item.sessionId} idleMin=${Math.round(item.idleMin)} mb=${item.mb.toFixed(1)}`);
    if (opts.kill) {
      const failedIdle = (deps.stopTrees ?? ((items) => stopProcessTrees(items, deps.spawnImpl)))(idleClaude);
      appendIdleLog(home, idleClaude.filter((item) => !failedIdle.includes(item.pid)));
      console.log(`process-hygiene: vscode-claude-idle stopped=${idleClaude.length - failedIdle.length} failed=${failedIdle.length}`);
    }
    if (opts.kill) {
      await maybeAlert(stale, opts.alertThreshold, home, now, deps.notify ?? notifyKim);
      const failed = (deps.stopProcesses ?? ((items) => stopProcesses(items, deps.spawnImpl)))(stale);
      const failedWindows = (deps.stopOrphanWindows ?? ((items) => stopProcesses(items, deps.spawnImpl)))(orphanWindows);
      const after = stale.filter((item) => failed.includes(item.pid));
      const remainingWindows = orphanWindows.filter((item) => failedWindows.includes(item.pid));
      appendLog(home, stale, after);
      console.log(`process-hygiene: after ${summary(after)}`);
      console.log(`process-hygiene: orphan-console-windows after ${summary(remainingWindows)}`);
    }
    return 0;
  } finally { releaseLock('process-hygiene'); }
}

if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); } catch (error) { console.error(`process-hygiene: ${error.message}`); process.exitCode = 1; }
}
