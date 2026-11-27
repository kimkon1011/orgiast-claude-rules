#!/usr/bin/env node
// 全PC: VS Code「Claude Code: Sessions」を30件以内に保つ退避を毎時実行。
// 削除せず projects-archive へ移動。busy / 60分以内更新のプロセスは触らない。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
import { readState, scopeRoots, projectDirs, vscodeDir } from './session-cap.mjs';
import { isEntry } from './is-entry.mjs';

const MINUTE = 60_000;
const entries = dir => {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
};
function getProcesses() {
  const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'],
  { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 30_000, windowsHide: true });
  const value = JSON.parse(output), rows = Array.isArray(value) ? value : [value];
  if (!rows.length || rows.some(p => !Number.isInteger(p?.ProcessId))) throw new Error('invalid process list');
  return { pids: new Set(rows.map(p => p.ProcessId)), cmdlines: rows.map(p => p.CommandLine || '').join('\n') };
}
function sessionProcesses(base, pids) {
  const bySession = new Map();
  for (const entry of entries(path.join(base, 'sessions'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(base, 'sessions', entry.name);
    const row = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!pids.has(row.pid)) continue;
    if (!bySession.has(row.sessionId)) bySession.set(row.sessionId, []);
    bySession.get(row.sessionId).push(row);
  }
  return bySession;
}
function isBusy(procs, now) {
  return procs.some(p => {
    const updated = typeof p.updatedAt === 'number' ? p.updatedAt : Date.parse(p.updatedAt);
    return !['idle', 'waiting'].includes(p.status) || !Number.isFinite(updated) || now - updated <= 60 * MINUTE;
  });
}
function inspect(file, now, cmdlines) {
  const st = fs.statSync(file), text = fs.readFileSync(file, 'utf8');
  const id = path.basename(file, '.jsonl');
  const eps = new Set([...text.matchAll(/"entrypoint"\s*:\s*"([^"]+)"/g)].map(m => m[1]));
  const inter = eps.has('cli') || eps.has('claude-vscode');
  let lastA = '', userTurns = 0, title = '';
  const asks = new Set(), answered = new Set();
  for (const line of text.split('\n')) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    if (row.customTitle) title = row.customTitle;
    const c = row.message?.content;
    if (row.type === 'user' && !row.isMeta && (typeof c === 'string' ||
      (Array.isArray(c) && c.some(x => x.type === 'text')))) userTurns++;
    if (Array.isArray(c)) for (const x of c) {
      if (x.type === 'text' && row.type === 'assistant') lastA = x.text;
      if (x.type === 'tool_use' && x.name === 'AskUserQuestion') asks.add(x.id);
      if (x.type === 'tool_result') answered.add(x.tool_use_id);
    }
  }
  const ageMin = (now - st.mtimeMs) / MINUTE;
  let why = '';
  if (!inter) { if (ageMin >= 30 && !cmdlines.includes(id)) why = 'sdk-done'; }
  else if (/このセッション\s*[:：][^\n]*(閉じてよい|閉じて可)/.test(lastA.slice(-400)) ||
    /^【閉じて可】/.test(title.replace(/^KimPC｜/, ''))) why = 'closable';
  else if (/Login expired/.test(lastA) && userTurns <= 1) why = 'login-expired';
  else if (st.size < 2000 && !lastA) why = 'empty';
  else if ([...asks].some(a => !answered.has(a)) && userTurns <= 1 &&
    /session-start|待機中|引き継ぎ/.test(title + text.slice(0, 4000)) && ageMin > 360) why = 'start-dup';
  return { id, file, projectId: path.basename(path.dirname(file)), inter, why, mtime: st.mtimeMs, size: st.size };
}
function moveSession(row, base, now) {
  const arch = path.join(base, 'projects-archive', row.projectId);
  const side = path.join(path.dirname(row.file), row.id);
  let stem = path.join(arch, row.id), attempt = 0;
  while (fs.existsSync(stem + '.jsonl') || fs.existsSync(stem)) {
    stem = path.join(arch, 'resurrected', `${row.id}.${now}${attempt ? `.${attempt}` : ''}`);
    attempt++;
  }
  const dest = stem + '.jsonl', hasSide = fs.existsSync(side);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (hasSide) fs.renameSync(side, stem);
  try { fs.renameSync(row.file, dest); }
  catch (e) { if (hasSide) fs.renameSync(stem, side); throw e; }
  try {
    fs.appendFileSync(path.join(base, 'archived-sessions.jsonl'), JSON.stringify({
      sessionId: row.id, projectId: row.projectId, reason: `cap30-enforce:${row.why}`,
      at: new Date(now).toISOString(), dest,
    }) + '\n');
  } catch (e) {
    fs.renameSync(dest, row.file);
    if (hasSide) fs.renameSync(stem, side);
    throw e;
  }
}
export async function main({ home = os.homedir(), vscodeUserDir = vscodeDir(home), now = Date.now(),
  dryRun = false, platform = process.platform, getProcesses: processes = getProcesses,
  kill = pid => process.kill(pid) } = {}) {
  if (platform !== 'win32') return 0;
  now = typeof now === 'number' ? now : new Date(now).getTime();
  if (!Number.isFinite(now)) throw new Error('invalid now');
  const base = path.join(home, '.claude'), logf = path.join(base, 'logs/session-cap-enforce-history.log');
  const log = text => {
    fs.mkdirSync(path.dirname(logf), { recursive: true });
    fs.appendFileSync(logf, `${new Date(now).toISOString()} ${text}\n`); console.log(text);
  };
  const stateFile = path.join(vscodeUserDir, 'globalStorage/state.vscdb');
  if (!fs.existsSync(vscodeUserDir) || !fs.existsSync(stateFile)) { log('skip: VS Code state missing'); return 0; }
  let hidden, dirs, pids, cmdlines, bySession;
  try {
    hidden = new Set(readState(stateFile).hiddenSessionIds || []);
    dirs = projectDirs(base, scopeRoots(vscodeUserDir, home));
    ({ pids, cmdlines } = await processes());
    bySession = sessionProcesses(base, pids);
  } catch (e) { log(`scan fail ${e.message}`); return 1; }
  const rows = [];
  for (const dir of dirs) for (const entry of entries(dir)) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl') || hidden.has(entry.name.slice(0, -6))) continue;
    const row = inspect(path.join(dir, entry.name), now, cmdlines);
    row.procs = bySession.get(row.id) || []; row.busy = isBusy(row.procs, now);
    rows.push(row);
  }
  // 目的選び重複は対象プロジェクト全体で最新1本を残す。
  const dups = rows.filter(r => r.why === 'start-dup').sort((a, b) => b.mtime - a.mtime);
  if (dups[0]) dups[0].why = '';
  let moved = 0, killed = 0, skippedBusy = 0, failed = 0;
  for (const row of rows.filter(r => r.why)) {
    if (row.busy) { skippedBusy++; continue; }
    if (dryRun) { row.archived = true; moved++; log(`DRY would ${row.why} ${row.id}`); continue; }
    try {
      // kill 直前にも status と更新時刻を読み直す。
      const fresh = sessionProcesses(base, pids).get(row.id) || [];
      if (isBusy(fresh, now)) { row.busy = true; skippedBusy++; continue; }
      for (const p of fresh) { await kill(p.pid); killed++; }
      if (fresh.length) await setTimeout(4000);
      if (isBusy(sessionProcesses(base, pids).get(row.id) || [], now)) { row.busy = true; skippedBusy++; continue; }
      const stat = fs.statSync(row.file);
      if (stat.size !== row.size || stat.mtimeMs !== row.mtime) throw new Error('changed-during-scan');
      moveSession(row, base, now); row.archived = true; moved++;
    } catch (e) { failed++; log(`move fail ${row.id} ${e.code || e.message}`); }
  }
  const after = rows.length - moved;
  log(`${dryRun ? 'DRY ' : ''}files ${rows.length} -> ${after} moved=${moved} killedIdle=${killed} skippedBusy=${skippedBusy} interactiveLeft=${rows.filter(r => r.inter && !r.archived).length}${after > 30 ? ' OVER30' : ''}`);
  return failed ? 1 : 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = await main({ dryRun: process.argv.includes('--dry-run') }); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
