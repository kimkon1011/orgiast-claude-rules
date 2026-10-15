#!/usr/bin/env node
// Archives stale Remote Control sessions on claude.ai (the "Code" list in the mobile/web app).
// Archive only hides a session from the list; the conversation stays on the server.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const root = () => path.join(os.homedir(), '.claude');
const HOUR = 3_600_000;
const COOLDOWN = 6 * HOUR;
const STALE = 24 * HOUR;
const BASE = 'https://api.anthropic.com';
function json(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

function headers() {
  const token = json(path.join(root(), '.credentials.json')).claudeAiOauth?.accessToken;
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

export async function purgeRemote({ dryRun = false, fetchImpl = fetch, now = Date.now() } = {}) {
  const stateFile = path.join(root(), 'purge-remote-sessions-state.json');
  if (!dryRun && now - (json(stateFile).at ?? 0) < COOLDOWN) return { skipped: 'cooldown' };
  const h = headers();
  if (!h) return { skipped: 'no-credentials' };
  if (!dryRun) fs.writeFileSync(stateFile, JSON.stringify({ at: now }));
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
  const targets = sessions.filter((s) => isStale(s, now));
  const result = { listed: sessions.length, targets: targets.length, archived: 0, failed: 0 };
  if (dryRun) return { ...result, titles: targets.map((s) => (s.title ?? '').split('\n')[0].slice(0, 60)) };
  const log = path.join(root(), 'archived-remote-sessions.jsonl');
  for (const s of targets) {
    const r = await fetchImpl(`${BASE}/v1/code/sessions/${encodeURIComponent(s.id)}/archive`, { method: 'POST', headers: h, body: '{}', signal: AbortSignal.timeout(10_000) });
    if (r.status === 200 || r.status === 409) {
      result.archived++;
      fs.appendFileSync(log, JSON.stringify({ id: s.id, title: (s.title ?? '').split('\n')[0].slice(0, 60), last: s.last_event_at, at: new Date(now).toISOString() }) + '\n');
    } else result.failed++;
  }
  return result;
}

if (isEntry(import.meta.url)) {
  purgeRemote({ dryRun: process.argv.includes('--dry-run') })
    .then((r) => console.log(JSON.stringify(r)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
