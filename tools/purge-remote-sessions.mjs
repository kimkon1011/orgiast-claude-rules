#!/usr/bin/env node
// Archives stale Remote Control sessions on claude.ai (the "Code" list in the mobile/web app).
// Archive only hides a session from the list; the conversation stays on the server.
//
// Safety rule (2026-10-18 incident: 28 un-closed sessions were archived by time alone):
// a server session is archived only when the local purge already moved its transcript to
// projects-archive/. The link is the `bridgeSessionId` line that Claude Code writes as the
// first line of every Remote Control session JSONL, so "closed on this PC" is the evidence.
// Sessions with no local transcript (mobile-only) or with a live transcript are left alone.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const root = () => path.join(os.homedir(), '.claude');
const HOUR = 3_600_000;
const COOLDOWN = 6 * HOUR;
const STALE = 24 * HOUR;
const HEAD_BYTES = 8192;
const BASE = 'https://api.anthropic.com';
function json(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

function headers(base = root()) {
  const token = json(path.join(base, '.credentials.json')).claudeAiOauth?.accessToken;
  const org = json(path.join(os.homedir(), '.claude.json')).oauthAccount?.organizationUuid;
  if (!token || !org) return null;
  return {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
    'anthropic-beta': 'ccr-byoc-2025-07-29', 'x-organization-uuid': org,
  };
}

export function isStale(session, now = Date.now()) {
  const last = Date.parse(session.last_event_at ?? session.updated_at ?? session.created_at);
  return session.status !== 'archived' && session.connection_status === 'disconnected' && Number.isFinite(last) && now - last >= STALE;
}

function bridgeId(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(HEAD_BYTES);
      const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
      return buf.subarray(0, n).toString('utf8').match(/"bridgeSessionId":"(cse_[A-Za-z0-9_]+)"/)?.[1] ?? null;
    } finally { fs.closeSync(fd); }
  } catch { return null; }
}

function jsonlFiles(dir) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const projectId of names) {
    const projectDir = path.join(dir, projectId);
    let files = [];
    try { if (!fs.statSync(projectDir).isDirectory()) continue; files = fs.readdirSync(projectDir); } catch { continue; }
    for (const file of files) if (file.endsWith('.jsonl')) out.push({ projectId, sessionId: file.slice(0, -6), file: path.join(projectDir, file) });
  }
  return out;
}

// cse_… -> local session id, for server sessions whose transcript this PC already archived.
// A cse id seen in a live transcript (projects/ or current-sessions/) is never returned:
// restored or still-running sessions must stay visible on the phone.
export function closedRemoteIds({ base = root() } = {}) {
  const protectedIds = new Set();
  let protectedFiles = [];
  try { protectedFiles = fs.readdirSync(path.join(base, 'current-sessions')); } catch { /* none */ }
  for (const file of protectedFiles) if (file.endsWith('.json')) protectedIds.add(file.slice(0, -5));

  const closed = new Map();
  const live = new Set();
  for (const entry of jsonlFiles(path.join(base, 'projects-archive'))) {
    const cse = bridgeId(entry.file);
    if (cse) closed.set(cse, entry.sessionId);
  }
  for (const entry of jsonlFiles(path.join(base, 'projects'))) {
    const cse = bridgeId(entry.file);
    if (cse) live.add(cse);
  }
  for (const [cse, sessionId] of closed) if (live.has(cse) || protectedIds.has(sessionId)) closed.delete(cse);
  return closed;
}

export function selectTargets(sessions, closed, now = Date.now()) {
  const stale = sessions.filter((s) => isStale(s, now));
  return { stale, targets: stale.filter((s) => closed.has(s.id)) };
}

export async function purgeRemote({ dryRun = false, fetchImpl = fetch, now = Date.now(), base = root(), headersImpl = headers } = {}) {
  const stateFile = path.join(base, 'purge-remote-sessions-state.json');
  if (!dryRun && now - (json(stateFile).at ?? 0) < COOLDOWN) return { skipped: 'cooldown' };
  const h = headersImpl(base);
  if (!h) return { skipped: 'no-credentials' };
  const sessions = [];
  let cursor = '';
  for (let page = 0; page < 30; page++) {
    const q = new URLSearchParams({ limit: '100', ...(cursor && { cursor }) });
    const r = await fetchImpl(`${BASE}/v1/code/sessions?${q}`, { headers: h, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return { error: `list ${r.status}` };
    const j = await r.json();
    sessions.push(...(j.data ?? []));
    if (!j.next_cursor || !(j.data ?? []).length) break;
    cursor = j.next_cursor;
  }
  const closed = closedRemoteIds({ base });
  const { stale, targets } = selectTargets(sessions, closed, now);
  const result = { listed: sessions.length, stale: stale.length, targets: targets.length, unlinked: stale.length - targets.length, archived: 0, failed: 0 };
  if (dryRun) return { ...result, titles: targets.map((s) => (s.title ?? '').split('\n')[0].slice(0, 60)) };
  // Record the attempt before archiving so a crash cannot loop forever on one session.
  if (!dryRun) fs.writeFileSync(stateFile, JSON.stringify({ at: now }));
  const log = path.join(base, 'archived-remote-sessions.jsonl');
  for (const s of targets) {
    const r = await fetchImpl(`${BASE}/v1/code/sessions/${encodeURIComponent(s.id)}/archive`, { method: 'POST', headers: h, body: '{}', signal: AbortSignal.timeout(10_000) });
    if (r.status === 200 || r.status === 409) {
      result.archived++;
      fs.appendFileSync(log, JSON.stringify({ id: s.id, localId: closed.get(s.id), reason: 'closed-locally', title: (s.title ?? '').split('\n')[0].slice(0, 60), last: s.last_event_at, at: new Date(now).toISOString() }) + '\n');
    } else result.failed++;
  }
  return result;
}

if (isEntry(import.meta.url)) {
  purgeRemote({ dryRun: process.argv.includes('--dry-run') })
    .then((r) => console.log(JSON.stringify(r)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
