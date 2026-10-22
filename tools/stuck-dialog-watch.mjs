#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { WINDOWS_PROCESS_SCRIPT } from './lib/windows-process.mjs';
import { parseProcessLines } from './process-hygiene.mjs';
import { reportHeartbeat } from './lib/heartbeat.mjs';
import { acquireLock, releaseLock } from './lib/single-instance.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { notifyKim } from './notify-kim.mjs';
import { localDate } from './auto-session.mjs';
import { DAY_MS, readJson, writeJson, dialogMetrics } from './lib/stuck-dialog-state.mjs';

const user32 = `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class DialogWindows {
  public delegate bool Callback(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
}
'@`;
function powershell(command, spawnImpl = spawnSync, timeout = 15000) {
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.Encoding]::UTF8\n${command}`, 'utf16le').toString('base64')], { windowsHide: true, shell: false, encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || `PowerShell exit ${result.status}`);
  return String(result.stdout || '').replace(/^\uFEFF/, '').trim();
}
export function snapshot(spawnImpl) {
  const raw = JSON.parse(powershell(`$lines=@(& { ${WINDOWS_PROCESS_SCRIPT} })
${user32}
$windows=[Collections.Generic.List[object]]::new()
[DialogWindows]::EnumWindows({param($handle,$unused)
  if([DialogWindows]::IsWindowVisible($handle)) {
    $text=[Text.StringBuilder]::new(2048);[void][DialogWindows]::GetWindowText($handle,$text,2048)
    [uint32]$owner=0;[void][DialogWindows]::GetWindowThreadProcessId($handle,[ref]$owner)
    $windows.Add([pscustomobject]@{pid=$owner;handle=$handle.ToInt64().ToString();title=$text.ToString()})
  };return $true
},[IntPtr]::Zero)|Out-Null
[pscustomobject]@{lines=$lines;windows=@($windows.ToArray())}|ConvertTo-Json -Depth 5 -Compress`, spawnImpl));
  const parsed = parseProcessLines((raw.lines || []).join('\n'));
  if (parsed.failedLines) throw new Error(`プロセス一覧の解析失敗 ${parsed.failedLines}件`);
  return { processes: parsed.processes.map(p => ({ pid: p.ProcessId, ppid: p.ParentProcessId, name: p.Name, commandLine: p.CommandLine, creationDate: p.CreationDate })), windows: raw.windows || [] };
}
export function runningTasks(spawnImpl) {
  // Query only matching task states, without per-task history calls. Allow a cold
  // ScheduledTasks module 30s; tick records failure and still closes the dialog.
  return JSON.parse(powershell("ConvertTo-Json -InputObject @(Get-ScheduledTask -TaskName 'Orgiast*' | Where-Object State -eq Running | Select-Object TaskName,TaskPath,State) -Compress", spawnImpl, 30000));
}
export function findDialogs({ processes, windows }, titles) {
  const result = [];
  for (const p of processes) {
    if (/^(OpenWith|WerFault)\.exe$/i.test(p.name)) result.push({ ...p, kind: p.name.toLowerCase(), title: windows.find(w => w.pid === p.pid)?.title || '', handle: null });
  }
  for (const w of windows) {
    if (result.some(d => d.pid === w.pid && d.handle === null)) continue;
    const title = titles.find(t => w.title.toLowerCase().includes(t.toLowerCase()));
    const p = processes.find(p => p.pid === w.pid);
    if (title && p) result.push({ ...p, ...w, kind: `title:${title}` });
  }
  return result;
}
const identity = p => `${p.pid}:${p.creationDate}`;
export class ProcessHistory {
  rows = new Map();
  update(processes, now) {
    // Keep live ancestors even if older than 60s, and exited processes for 60s.
    const live = new Set(processes.map(identity));
    for (const p of processes) this.rows.set(identity(p), { ...p, seenAt: now });
    for (const [key, p] of this.rows) if (!live.has(key) && now - p.seenAt > 60000) this.rows.delete(key);
  }
  candidates(dialog) {
    const at = Date.parse(dialog.creationDate);
    const rows = [...this.rows.values()];
    const clean = ({ seenAt, ...p }) => p;
    return rows.filter(p => p.pid !== dialog.pid && Date.parse(p.creationDate) <= at && Date.parse(p.creationDate) >= at - 15000).map(p => {
      const parents = []; let current = p; const seen = new Set([identity(p)]);
      for (let depth = 0; depth < 4; depth++) {
        const parent = rows.filter(r => r.pid === current.ppid && Date.parse(r.creationDate) <= Date.parse(current.creationDate)).sort((a,b) => Date.parse(b.creationDate) - Date.parse(a.creationDate))[0];
        if (!parent || seen.has(identity(parent))) break;
        seen.add(identity(parent)); parents.push(clean(parent)); current = parent;
      }
      return { ...clean(p), parents };
    }).sort((a,b) => Date.parse(b.creationDate) - Date.parse(a.creationDate));
  }
}
export function closeDialog(dialog, spawnImpl) {
  if (!Number.isSafeInteger(dialog.pid) || dialog.pid <= 0) throw new Error('invalid dialog pid');
  const quote = s => `'${String(s).replaceAll("'", "''")}'`;
  // PID reuse must not kill a different process between capture and close.
  const guard = `$p=Get-Process -Id ${dialog.pid} -ErrorAction SilentlyContinue;if(!$p){return};if([Math]::Abs(($p.StartTime.ToUniversalTime()-[DateTime]::Parse(${quote(dialog.creationDate)}).ToUniversalTime()).TotalMilliseconds) -gt 10){throw 'PID reused'}`;
  if (/^(openwith|werfault)\.exe$/.test(dialog.kind)) {
    powershell(`${guard};if(($p.ProcessName+'.exe') -ine ${quote(dialog.name)}){throw 'Process changed'};Stop-Process -InputObject $p -Force`, spawnImpl);
  } else {
    if (!/^\d+$/.test(String(dialog.handle))) throw new Error('invalid window handle');
    powershell(`${guard}\n${user32}\n$h=[IntPtr]::new([long]${dialog.handle});[uint32]$owner=0;[void][DialogWindows]::GetWindowThreadProcessId($h,[ref]$owner);if($owner -ne ${dialog.pid}){throw 'Window changed'};if(![DialogWindows]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)){throw 'WM_CLOSE failed'}`, spawnImpl);
  }
}
export async function tick(context, io = {}) {
  const { home, history, patterns } = context;
  const now = (io.now || Date.now)();
  const data = await (io.snapshot || snapshot)();
  history.update(data.processes, now);
  const dialogs = findDialogs(data, patterns);
  const stateFile = path.join(home, '.claude', 'state', 'stuck-dialog-watch.json');
  const state = readJson(stateFile, { events: [], notified: {}, seen: [] });
  state.events = (state.events || []).filter(e => now - e.at < DAY_MS);
  state.notified ||= {};
  const liveKeys = new Set(dialogs.map(d => `${identity(d)}:${d.handle || ''}`));
  state.seen = (state.seen || []).filter(k => liveKeys.has(k));
  const fresh = dialogs.filter(d => !state.seen.includes(`${identity(d)}:${d.handle || ''}`));
  let tasks = [], taskError;
  if (fresh.length) { try { tasks = await (io.runningTasks || runningTasks)(); } catch(e) { taskError = e.message; } }
  const file = path.join(home, '.claude', 'logs', 'stuck-dialog', `${localDate(new Date(now))}.jsonl`);
  for (const dialog of fresh) {
    const record = { at: new Date(now).toISOString(), kind: dialog.kind, dialogPid: dialog.pid, title: dialog.title, creationDate: dialog.creationDate, candidates: history.candidates(dialog), runningScheduledTasks: tasks, ...(taskError ? { taskQueryError: taskError } : {}) };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, JSON.stringify(record) + '\n', { mode: 0o600 }); // durable evidence precedes closure
    state.events.push({ at: now, kind: dialog.kind, file, top: record.candidates.slice(0,3).map(p => `${p.name}(PID ${p.pid})`).join('、') });
    state.seen.push(`${identity(dialog)}:${dialog.handle || ''}`);
    writeJson(stateFile, state);
  }
  const errors = dialogs.filter(d => !fresh.includes(d)).map(d => ({ dialogPid: d.pid, stillOpen: true }));
  for (const dialog of dialogs) { // retry failed or ignored closes without duplicating evidence
    try { await (io.close || closeDialog)(dialog); }
    catch(e) { errors.push({ dialogPid: dialog.pid, error: e.message }); }
  }
  if (errors.length) fs.appendFileSync(file, JSON.stringify({ at: new Date(now).toISOString(), closeErrors: errors }) + '\n', { mode: 0o600 });
  for (const kind of new Set(state.events.map(e => e.kind))) {
    const events = state.events.filter(e => e.kind === kind && e.at > (state.notified[kind] || 0));
    if (!events.length || now - (state.notified[kind] || 0) < 6 * 3600000) continue;
    const top = events.at(-1).top || '証拠ファイルを参照';
    const evidenceFile = events.at(-1).file || file;
    // Persist the attempt first: even a network failure cannot cause a notification storm.
    state.notified[kind] = now; writeJson(stateFile, state);
    try { await (io.notify || notifyKim)(`${(io.label || resolveFleetLabel)(home)}: 操作を止める画面 ${kind} を${events.length}件検出。終了を試みました。直前の候補: ${top}。証拠: ${evidenceFile}`, { home }); }
    catch(e) { errors.push({ notificationError: e.message }); }
  }
  writeJson(stateFile, state);
  return { ...dialogMetrics(home, now), detected: fresh.length, errors };
}
export async function main(argv = process.argv.slice(2), io = {}) {
  if ((io.platform || process.platform) !== 'win32') return { skipped: 'Windowsのみ' };
  const number = (flag, fallback) => { const i=argv.indexOf(flag); const n=i<0?fallback:Number(argv[i+1]); if(!Number.isFinite(n)||n<=0) throw new Error(`invalid ${flag}`); return n; };
  if (argv[0] !== 'loop') throw new Error('usage: stuck-dialog-watch.mjs loop --seconds 290 --interval 2');
  const seconds = number('--seconds',290), interval = number('--interval',2);
  const home = io.home || process.env.USERPROFILE || os.homedir();
  const lock = (io.acquireLock || acquireLock)('stuck-dialog-watch');
  if (!lock.acquired) return { skipped: '実行中' };
  const now = io.now || Date.now, started = now();
  const context = { home, history: new ProcessHistory(), patterns: readJson(new URL('./stuck-dialog-patterns.json',import.meta.url)).titles };
  try {
    do {
      const before = now(); let result;
      try { result = await tick(context, io); }
      catch(e) { result = { errors: [{ error: e.message }] }; }
      await (io.heartbeat || reportHeartbeat)({ job: 'stuck-dialog-watch', startedAt: new Date(started).toISOString(), finishedAt: new Date(now()).toISOString(), ok: !result.errors.length, summary: JSON.stringify(result), cycleMinutes: 5 }, { homeDir: home, localOnly: true });
      console.log(`${new Date(now()).toISOString()} stuck-dialog-watch ${JSON.stringify(result)}`);
      const remaining = started + seconds * 1000 - now();
      if (remaining <= 0) break;
      await (io.sleep || (ms => new Promise(r => setTimeout(r,ms))))(Math.min(remaining, Math.max(0, interval * 1000 - (now()-before))));
    } while(now() < started + seconds * 1000);
  } finally { (io.releaseLock || releaseLock)('stuck-dialog-watch'); }
}
if (isEntry(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode=1; });
