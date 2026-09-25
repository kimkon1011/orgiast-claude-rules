#!/usr/bin/env node
// One-shot, reversible transcript archival. Never accesses the extension DB.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const root = () => path.join(os.homedir(), '.claude');
const MINUTE = 60_000;
const MAX_FILES = 500;
const MAX_LINE_BYTES = 32 * 1024 * 1024;
function json(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function write(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function entries(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
function acquire(file) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
      fs.closeSync(fd);
      return () => fs.unlinkSync(file);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stat;
      try { stat = fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const { pid } = json(file);
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid, 0); return null; } catch (error) { if (error.code !== 'ESRCH') return null; }
      } else if (Date.now() - stat.mtimeMs < MINUTE) return null;
      // Do not remove a lock replaced since it was inspected.
      let current;
      try { current = fs.statSync(file); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (current.ino !== stat.ino || current.mtimeMs !== stat.mtimeMs) return null;
      try { fs.unlinkSync(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  return null;
}
function liveIds(base, now) {
  const ids = new Set();
  for (const entry of entries(path.join(base, 'current-sessions'))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const row = json(path.join(base, 'current-sessions', entry.name));
    if (row.sessionId && now - Date.parse(row.at) <= 10 * MINUTE) ids.add(row.sessionId);
  }
  return ids;
}
function content(row) {
  const c = row.message?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.filter(x => x?.type === 'text').map(x => x.text || '').join('\n') : '';
}
function commandOnly(text) {
  return /^\s*<(?:local-command-caveat|command-name|command-message|local-command-stdout)>/.test(text);
}
function handoff(text, label) {
  const lines = text.split('\n');
  const start = lines.findLastIndex(line => line.includes(label));
  if (start < 0) return undefined;
  let end = start + 1;
  while (end < lines.length && !/^\s*(?:#{1,6}\s|(?:\*\*)?(?:次に kim がすること|この後の自動進行|このセッション[:：]))/.test(lines[end])) end++;
  return lines.slice(start, end).join('\n').trim();
}
function* transcriptLines(file, deadline) {
  const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(64 * 1024), decoder = new StringDecoder('utf8');
  let pending = '';
  try {
    for (;;) {
      if (Date.now() >= deadline) throw new Error('scan budget reached');
      const count = fs.readSync(fd, buffer, 0, buffer.length, null);
      pending += count ? decoder.write(buffer.subarray(0, count)) : decoder.end();
      let start = 0, end;
      while ((end = pending.indexOf('\n', start)) >= 0) { yield pending.slice(start, end); start = end + 1; }
      pending = pending.slice(start);
      if (pending.length > MAX_LINE_BYTES) throw new Error('oversized JSONL line');
      if (!count) { if (pending) yield pending; break; }
    }
  } finally { fs.closeSync(fd); }
}
function* reverseLines(file, size, deadline) {
  const fd = fs.openSync(file, 'r');
  let offset = size, pending = Buffer.alloc(0);
  try {
    while (offset > 0) {
      if (Date.now() >= deadline) throw new Error('scan budget reached');
      const length = Math.min(offset, 256 * 1024);
      offset -= length;
      const chunk = Buffer.alloc(length);
      fs.readSync(fd, chunk, 0, length, offset);
      const data = Buffer.concat([chunk, pending]);
      let end = data.length, newline;
      while ((newline = data.lastIndexOf(10, end - 1)) >= 0) {
        yield data.subarray(newline + 1, end).toString('utf8');
        end = newline;
        if (end === 0) break;
      }
      pending = data.subarray(0, end);
      if (pending.length > MAX_LINE_BYTES) throw new Error('oversized JSONL line');
    }
    if (pending.length) yield pending.toString('utf8');
  } finally { fs.closeSync(fd); }
}
function inspectLarge(file, stat, deadline, now, closed) {
  const data = { empty: false, title: '', lastAt: NaN, approved: false };
  // Titles are at the front; activity, approval and latest handoffs are at the back.
  for (const line of transcriptLines(file, deadline)) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { return null; }
    const text = content(row).trim();
    if (row.type === 'user' && text && !commandOnly(text)) { data.title = [...text].slice(0, 60).join(''); break; }
  }
  if (closed) return data;
  let first = true, foundAssistant = false, userAfter = false;
  for (const line of reverseLines(file, stat.size, deadline)) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { return null; }
    if (first) {
      data.lastAt = Date.parse(row.timestamp); first = false;
      if (!(now - data.lastAt >= 10 * MINUTE)) return data;
    }
    const text = content(row).trim();
    if (!foundAssistant && row.type === 'user' && ((text && !commandOnly(text)) || (Array.isArray(row.message?.content) && row.message.content.some(x => x.type !== 'text')))) userAfter = true;
    if (row.type !== 'assistant') continue;
    if (!foundAssistant) { data.approved = text.includes('このセッション: アーカイブしてよい') && !userAfter; foundAssistant = true; }
    if (data.approved || now - data.lastAt < 72 * 60 * MINUTE) return data;
    data.nextKim ??= handoff(text, '次に kim がすること');
    data.automatic ??= handoff(text, 'この後の自動進行');
    if (data.nextKim !== undefined && data.automatic !== undefined) return data;
  }
  return data;
}
function inspect(file, stat, deadline, now, closed) {
  if (stat.size > 200_000) return inspectLarge(file, stat, deadline, now, closed);
  if (Date.now() >= deadline) throw new Error('scan budget reached');
  const lines = transcriptLines(file, deadline);
  let empty = stat.size <= 200_000, title = '', lastAssistant = '', userAfter = false, lastAt = NaN;
  let nextKim, automatic;
  for (const line of lines) {
    if (!line.trim()) continue;
    if (Date.now() >= deadline) throw new Error('scan budget reached');
    let row;
    try { row = JSON.parse(line); } catch { return null; } // Incomplete/corrupt transcripts stay in place.
    lastAt = Date.parse(row.timestamp); // Last JSONL row, never filesystem mtime for c/d.
    const text = content(row).trim();
    if (row.type === 'user' && text && !commandOnly(text)) {
      empty = false; userAfter = true;
      if (!title) title = [...text].slice(0, 60).join('');
    } else if (row.type === 'assistant') {
      lastAssistant = text; userAfter = false;
      if (text || (Array.isArray(row.message?.content) && row.message.content.length)) empty = false;
      nextKim = handoff(text, '次に kim がすること') ?? nextKim;
      automatic = handoff(text, 'この後の自動進行') ?? automatic;
    } else if (row.type === 'user' && Array.isArray(row.message?.content) && row.message.content.some(x => x.type !== 'text')) { empty = false; userAfter = true; }
  }
  return { empty, title, lastAt, approved: lastAssistant.includes('このセッション: アーカイブしてよい') && !userAfter, nextKim, automatic };
}
export function dropClosed(base, removed) {
  const file = path.join(base, 'closed-sessions.json');
  const latest = json(file, { ids: [] }); // Re-read immediately before subtracting, preserve other writers' IDs/fields.
  if (!Array.isArray(latest.ids) || !latest.ids.some(id => removed.has(id))) return;
  write(file, { ...latest, ids: latest.ids.filter(id => !removed.has(id)) });
}
function movePair(from, to, id) {
  fs.mkdirSync(to, { recursive: true });
  const source = path.join(from, `${id}.jsonl`), dest = path.join(to, `${id}.jsonl`);
  const side = path.join(from, id), destSide = path.join(to, id);
  if (fs.existsSync(dest) || fs.existsSync(destSide)) throw new Error(`destination already exists: ${id}`);
  const hasSide = fs.existsSync(side);
  if (hasSide) fs.renameSync(side, destSide);
  try { fs.renameSync(source, dest); }
  catch (error) { if (hasSide) fs.renameSync(destSide, side); throw error; }
}
export function purge({ dryRun = false, restore, after = '' } = {}) {
  const base = root(), now = Date.now(), deadline = now + 4500;
  const result = { sessions: [], scanned: 0, limited: false };
  if (!fs.existsSync(base)) return result;
  const release = dryRun ? () => {} : acquire(path.join(base, 'purge-sessions.lock'));
  if (!release) return { ...result, skipped: 'locked' };
  try {
    if (restore !== undefined) {
      if (!/^[\w-]+$/.test(restore)) throw new Error('invalid session ID');
      const hits = entries(path.join(base, 'projects-archive')).filter(e => e.isDirectory() && fs.existsSync(path.join(base, 'projects-archive', e.name, `${restore}.jsonl`)));
      if (hits.length !== 1) throw new Error(`restore needs exactly one match, found ${hits.length}`);
      const projectId = hits[0].name;
      movePair(path.join(base, 'projects-archive', projectId), path.join(base, 'projects', projectId), restore);
      dropClosed(base, new Set([restore]));
      // A restored transcript must not immediately qualify again at the next hook.
      fs.mkdirSync(path.join(base, 'current-sessions'), { recursive: true });
      write(path.join(base, 'current-sessions', `${restore}.json`), { sessionId: restore, at: new Date(now).toISOString() });
      return { restored: restore, projectId };
    }
    const stateFile = path.join(base, 'purge-sessions-state.json');
    const state = json(stateFile);
    if (!dryRun && now - state.at < 5 * MINUTE) return { ...result, skipped: 'cooldown' };
    const closed = new Set(json(path.join(base, 'closed-sessions.json')).ids || []);
    const live = liveIds(base, now);
    // Enumerate incrementally: collecting every project first can consume the entire
    // budget on Windows before inspecting even one transcript. Cursor also advances
    // across empty project directories, so every account eventually gets a full pass.
    function* candidates(cursor) {
      for (const project of entries(path.join(base, 'projects'))) {
        if (!project.isDirectory() || project.name.startsWith('_') || project.name < cursor.split('/')[0]) continue;
        const marker = project.name + '/';
        if (marker > cursor) yield { key: marker, directory: true };
        for (const entry of entries(path.join(base, 'projects', project.name))) {
          const key = marker + entry.name;
          if (entry.isFile() && entry.name.endsWith('.jsonl') && key > cursor) yield { key };
        }
      }
    }
    let cursor = dryRun ? after : state.cursor || '';
    for (const { key, directory } of candidates(cursor)) {
      if (result.scanned >= MAX_FILES || Date.now() >= deadline) { result.limited = true; break; }
      const previousCursor = cursor;
      cursor = key;
      if (directory) continue;
      result.scanned++;
      const [projectId, filename] = key.split('/'), sessionId = filename.slice(0, -6);
      if (live.has(sessionId)) continue;
      const from = path.join(base, 'projects', projectId), file = path.join(from, filename);
      try {
        const stat = fs.statSync(file), data = inspect(file, stat, deadline, now, closed.has(sessionId) && now - stat.mtimeMs >= 45_000);
        if (!data) continue;
        const age = now - stat.mtimeMs, activityAge = now - data.lastAt;
        const reason = closed.has(sessionId) && age >= 45_000 ? 'closed'
          : data.empty && age >= 90_000 ? 'empty'
          : data.approved && activityAge >= 10 * MINUTE ? 'approved'
          : activityAge >= 72 * 60 * MINUTE ? 'abandoned' : null;
        if (!reason) continue;
        const row = { sessionId, projectId, reason, title: data.title, at: new Date(now).toISOString(),
          ...(reason === 'abandoned' ? { nextKim: data.nextKim || '', automatic: data.automatic || '' } : {}) };
        if (!dryRun) {
          const fresh = fs.statSync(file);
          if (fresh.size !== stat.size || fresh.mtimeMs !== stat.mtimeMs || Date.now() - Date.parse(json(path.join(base, 'current-sessions', `${sessionId}.json`)).at) <= 10 * MINUTE) continue;
          const to = path.join(base, 'projects-archive', projectId);
          movePair(from, to, sessionId);
          try { fs.appendFileSync(path.join(base, 'archived-sessions.jsonl'), `${JSON.stringify(row)}\n`); }
          catch (error) { movePair(to, from, sessionId); throw error; }
          dropClosed(base, new Set([sessionId]));
        }
        result.sessions.push(row);
      } catch (error) {
        if (error.message === 'scan budget reached') {
          cursor = previousCursor; result.scanned--; result.limited = true; result.deferred = sessionId; break;
        }
        (result.errors ||= []).push({ sessionId, message: error.message });
      }
    }
    result.nextCursor = result.limited ? cursor : '';
    if (!dryRun) write(stateFile, { at: now, cursor: result.nextCursor });
    return result;
  } finally { release(); }
}
export function launchPurge() {
  if (Date.now() - json(path.join(root(), 'purge-sessions-state.json')).at < 5 * MINUTE) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { detached: true, windowsHide: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
}
if (isEntry(import.meta.url)) {
  try {
    if (process.argv.includes('--hook')) launchPurge();
    else {
      const index = process.argv.indexOf('--restore');
      if (index >= 0 && !process.argv[index + 1]) throw new Error('--restore requires session ID');
      if (index >= 0 && process.argv.includes('--dry-run')) throw new Error('--restore cannot be combined with --dry-run');
      const afterIndex = process.argv.indexOf('--after');
      if (afterIndex >= 0 && (!process.argv.includes('--dry-run') || !process.argv[afterIndex + 1])) throw new Error('--after requires --dry-run and a cursor');
      console.log(JSON.stringify(purge({ dryRun: process.argv.includes('--dry-run'), after: afterIndex >= 0 ? process.argv[afterIndex + 1] : '', ...(index >= 0 ? { restore: process.argv[index + 1] } : {}) })));
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
