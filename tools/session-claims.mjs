#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { purposeTokens, jaccard } from './lib/purpose-tokens.mjs';

export const COLLISION_THRESHOLD = 0.20;
const ACTIVE_AGE_MS = 8 * 60 * 60 * 1000;
const debug = message => { if (process.argv.includes('--debug')) console.error(`[session-claims] ${String(message).replace(/[\r\n]+/g, ' ')}`); };
const caught = (context, error) => debug(`${context}: ${error?.code || error?.name || 'Error'} ${error?.message || error}`);

const PURPOSE_MARKER = '**[本セッションの目的]**';

function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { caught(file, error); return null; }
}

function files(dir, suffix, recursive = false) {
  const found = [];
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { caught(dir, error); return found; }
  for (const entry of entries) {
    const file = path.join(dir, entry.name);
    if (recursive && entry.isDirectory()) found.push(...files(file, suffix, true));
    else if (entry.isFile() && entry.name.endsWith(suffix)) found.push(file);
  }
  return found;
}

function transcriptPurpose(file) {
  let purpose = '';
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    let rec;
    if (!line.trim()) continue;
    try { rec = JSON.parse(line); } catch (error) { caught(file, error); continue; }
    if (rec?.type !== 'assistant') continue;
    const content = rec.message?.content ?? rec.content;
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n') : '';
    for (const textLine of text.split(/\r?\n/)) {
      const at = textLine.lastIndexOf(PURPOSE_MARKER);
      if (at >= 0) purpose = textLine.slice(at + PURPOSE_MARKER.length).trim();
    }
  }
  return !purpose || purpose.includes('<目的>') ? '' : purpose;
}

// Physical line order is authoritative, including claim after release.
export function foldClaims(raw) {
  const current = new Map();
  for (const line of raw.split(/\r?\n/)) {
    let record;
    if (!line.trim()) continue;
    try { record = JSON.parse(line); } catch (error) { caught('claim log', error); continue; }
    if (!record || typeof record.sessionId !== 'string' || !record.sessionId
      || !Number.isFinite(Date.parse(record.ts))) continue;
    if (record.op === 'claim' && typeof record.purpose === 'string' && record.purpose.trim()) {
      current.set(record.sessionId, { ...claim(record.sessionId, record.purpose, record.ts, record.source), logOp: 'claim' });
    } else if (record.op === 'release') {
      // Keep a tombstone even when the claim came only from a transcript.
      const own = current.get(record.sessionId) || claim(record.sessionId, '', record.ts, 'release');
      current.set(record.sessionId, { ...own, logOp: 'release', released: true, releasedReason: record.reason || 'closed' });
    }
  }
  return [...current.values()];
}

function loadLog(file) {
  try { return foldClaims(fs.readFileSync(file, 'utf8')); }
  catch (error) { caught(file, error); if (error.code === 'ENOENT') return []; throw error; }
}

function claim(sessionId, purpose, time, source) {
  return { sessionId, short: sessionId.slice(0, 8), purpose, tokens: [...purposeTokens(purpose)],
    claimedAt: time, lastActivity: time, source, released: false, releasedReason: null };
}

export function syncClaims(base, previous = [], now = Date.now()) {
  const stats = { gateFiles: 0, gatePurposes: 0, transcripts: 0, recent: 0, declarations: 0 };
  const gates = new Map();
  for (const file of files(path.join(base, 'session-purpose'), '.json')) {
    stats.gateFiles++;
    try {
      const data = readJSON(file);
      if (!data || typeof data.purpose !== 'string' || !data.purpose.trim()) continue;
      stats.gatePurposes++;
      const id = typeof data.sessionId === 'string' && data.sessionId ? data.sessionId : path.basename(file, '.json');
      const mtime = fs.statSync(file).mtimeMs;
      // The gate normally contains the first user prompt, not a purpose.
      // Only a standalone declaration is an allowed fallback.
      const match = data.purpose.trim().match(/^\*\*\[本セッションの目的\]\*\*[^\S\r\n]*([^\r\n]+)$/u);
      const purpose = match?.[1].trim() || '';
      if (!gates.has(id) || gates.get(id).mtime < mtime) {
        gates.set(id, { purpose: purpose.includes('<目的>') ? '' : purpose, mtime });
      }
    } catch (error) { caught(file, error); }
  }
  debug(`session-purpose 走査 = ${stats.gateFiles} / purpose 取得 = ${stats.gatePurposes}`);
  const transcripts = new Map();
  for (const file of files(path.join(base, 'projects'), '.jsonl', true)) {
    stats.transcripts++;
    try {
      const id = path.basename(file, '.jsonl');
      const mtime = fs.statSync(file).mtimeMs;
      if (now - mtime <= ACTIVE_AGE_MS) stats.recent++;
      if (!transcripts.has(id) || transcripts.get(id).mtime < mtime) {
        // Expired transcripts only supply activity; reading their entire history
        // can dominate a sync on a real multi-session home.
        const purpose = now - mtime > ACTIVE_AGE_MS ? ''
          : transcriptPurpose(file);
        if (purpose) stats.declarations++;
        transcripts.set(id, { mtime, purpose });
      }
    } catch (error) { caught(file, error); }
  }
  // Rebuild inferred claims from declarations; never retain legacy prompt-derived claims.
  // Explicit --claim/--release operations retain their existing log semantics.
  const result = new Map(previous.filter(c => c.logOp).map(c => [c.sessionId, { ...c }]));
  let declaredSessions = 0, skippedSessions = 0;
  for (const id of new Set([...gates.keys(), ...transcripts.keys()])) {
    const gate = gates.get(id), transcript = transcripts.get(id), old = result.get(id);
    const purpose = transcript?.purpose || gate?.purpose;
    if (purpose) declaredSessions++;
    else skippedSessions++;
    // Explicit log operations own the purpose and release state. Backing files
    // may refresh a claim's activity, but cannot create a replacement claim.
    if (old?.logOp) {
      if (old.logOp === 'claim') {
        old.lastActivity = new Date(Math.max(Date.parse(old.lastActivity),
          transcript?.mtime ?? gate?.mtime ?? 0)).toISOString();
      }
      continue;
    }
    if (!purpose) continue;
    const activity = transcript?.mtime ?? gate.mtime;
    const current = claim(id, purpose, new Date(activity).toISOString(),
      transcript?.purpose ? 'transcript' : 'purpose-gate');
    result.set(id, current);
  }
  for (const current of result.values()) {
    if (current.logOp === 'release') continue;
    if (!current.released || current.releasedReason === 'stale') {
      current.released = now - Date.parse(current.lastActivity) > ACTIVE_AGE_MS;
      current.releasedReason = current.released ? 'stale' : null;
    }
  }
  debug(`session-purpose 走査 = ${stats.gateFiles} / purpose 取得 = ${stats.gatePurposes}; transcript 走査 = ${stats.transcripts} / transcript 8時間以内 = ${stats.recent} / assistant 宣言取得 = ${stats.declarations}; 宣言を持つセッション数 = ${declaredSessions} / 宣言が無くスキップした数 = ${skippedSessions}; 生存 claim = ${[...result.values()].filter(c => !c.released).length}`);
  return [...result.values()];
}

async function main() {
  const args = process.argv.slice(2);
  const value = name => { const i = args.indexOf(name); return i < 0 ? '' : args[i + 1] || ''; };
  const self = value('--self') || process.env.CLAUDE_SESSION_ID || '';
  const command = ['--sync', '--claim', '--release', '--filter', '--list'].find(c => args.includes(c));
  if (!command || (['--claim', '--release', '--filter'].includes(command) && !self)) return;
  const base = path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude');
  debug(`home = ${os.homedir()} / base = ${base} / command = ${command}`);
  const file = path.join(base, 'session-claims.json');
  // A cache-directory failure must not suppress read-only list/filter work.
  try { fs.mkdirSync(base, { recursive: true }); } catch (error) { caught(base, error); }
  const log = path.join(base, 'session-claims.jsonl');
  if (command === '--claim' || command === '--release') {
    const ts = new Date().toISOString();
    const purpose = value('--purpose').trim();
    if (command === '--claim' && !purpose) return;
    const record = command === '--claim'
      ? { ts, op: 'claim', sessionId: self, short: self.slice(0, 8), purpose,
        tokens: [...purposeTokens(purpose)], source: 'purpose-gate' }
      : { ts, op: 'release', sessionId: self, reason: value('--reason') || 'closed' };
    // Commit before any optional cache work. One Buffer, one O_APPEND write.
    fs.appendFileSync(log, Buffer.from(`${JSON.stringify(record)}\n`));
  }
  // Cache errors and lock contention must never suppress list/filter output.
  let updated = false;
  try { updated = await updateCache(base, file, log); } catch (error) { caught('updateCache', error); }
  if (command === '--sync' && updated) return;
  if (command === '--claim' || command === '--release') return;
  // Re-read after cache work to include operations committed during its scan.
  const claims = syncClaims(base, loadLog(log));
  const active = claims.filter(c => !c.released);
  if (command === '--list') {
    if (args.includes('--json')) console.log(JSON.stringify(active));
    else for (const c of active) console.log(`${c.short}  ${c.lastActivity}  ${c.purpose}`);
  }
  if (command === '--filter') {
    const candidates = fs.readFileSync(value('--candidates'), 'utf8').split(/\r?\n/);
    for (const candidate of candidates) {
      if (!candidate.trim() || candidate.trimStart().startsWith('#')) continue;
      const tokens = purposeTokens(candidate);
      const match = active.filter(c => c.sessionId !== self)
        .map(c => ({ c, sim: jaccard(tokens, purposeTokens(c.purpose)) }))
        .filter(m => m.sim >= COLLISION_THRESHOLD).sort((a, b) => b.sim - a.sim)[0];
      if (match) console.error(`dropped: ${candidate} <- claimed by ${match.c.short} (${match.sim.toFixed(2)})`);
      else console.log(candidate);
    }
  }
}

async function updateCache(base, file, log) {
  // Serialize the entire read/modify/rename transaction, including the shared .tmp file.
  const lock = path.join(base, 'session-claims.lock');
  const deadline = performance.now() + 2000;
  let ownedLock;
  while (true) {
    try {
      fs.mkdirSync(lock);
      ownedLock = fs.statSync(lock);
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') { caught(lock, error); return; }
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > 30000) {
          // Only remove an empty lock directory; never recursively remove a
          // directory another process might be using.
          fs.rmdirSync(lock);
        }
      } catch (staleError) {
        caught(lock, staleError);
        if (staleError.code !== 'ENOENT') return;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) { debug(`lock timeout: ${lock}`); return; }
      await new Promise(resolve => setTimeout(resolve, Math.min(20, remaining)));
      if (performance.now() >= deadline) { debug(`lock timeout: ${lock}`); return; }
    }
  }
  try {
    const claims = syncClaims(base, loadLog(log));
    const now = new Date().toISOString();
    const tmp = `${file}.tmp`;
    try {
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, updatedAt: now, claims }, null, 2)}\n`);
      fs.renameSync(tmp, file);
    } finally { fs.rmSync(tmp, { force: true }); }
    return true;
  } finally {
    // A stale owner must not remove a replacement owner's lock.
    const currentLock = fs.statSync(lock);
    if (currentLock.dev === ownedLock.dev && currentLock.ino === ownedLock.ino
      && currentLock.birthtimeMs === ownedLock.birthtimeMs) fs.rmdirSync(lock);
  }
}

if (isEntry(import.meta.url)) {
  try { await main(); } catch (error) { caught('main', error); } // fail-open; natural exit preserves buffered output.
}
