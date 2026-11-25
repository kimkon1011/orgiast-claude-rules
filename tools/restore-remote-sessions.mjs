#!/usr/bin/env node
// PC 終了で自動退避された会話だけを Code 一覧へ戻す。手動退避・明示クローズは尊重する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { closedUuidIndex } from './purge-remote-sessions.mjs';
import { hostExitArchive } from './lib/host-exit-archive.mjs';
export { hostExitArchive } from './lib/host-exit-archive.mjs';

const root = () => path.join(os.homedir(), '.claude');
const COOLDOWN = 15 * 60_000;
const RECENT = 7 * 24 * 3_600_000;
const BASE = 'https://api.anthropic.com/v1/code/sessions';
function json(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function rows(file) {
  let content;
  try { content = fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return content.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
function headers(base) {
  const token = json(path.join(base, '.credentials.json')).claudeAiOauth?.accessToken;
  const org = json(path.join(base, '..', '.claude.json')).oauthAccount?.organizationUuid;
  if (!token || !org) return null;
  return {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
    'anthropic-beta': 'ccr-byoc-2025-07-29', 'x-organization-uuid': org,
  };
}

export function isCandidate(session, now = Date.now()) {
  const updated = Date.parse(session.updated_at);
  const title = typeof session.title === 'string' ? session.title.trim() : '';
  return session.status === 'archived' && updated <= now && now - updated <= RECENT
    && !!title && !/^(remote-control-|desktop-|会話なし)/.test(title);
}

export async function restoreRemote({ dryRun = false, fetchImpl = fetch, now = Date.now(), base = root() } = {}) {
  const deadline = Date.now() + 60_000;
  const stateFile = path.join(base, 'restore-remote-sessions-state.json');
  if (!dryRun && now - (json(stateFile).at ?? 0) < COOLDOWN) return { skipped: 'cooldown' };
  const h = headers(base);
  if (!h) return { skipped: 'no-credentials' };
  if (!dryRun) fs.writeFileSync(stateFile, JSON.stringify({ at: now }));
  const index = closedUuidIndex(base, deadline);
  const archived = new Set(rows(path.join(base, 'archived-remote-sessions.jsonl')).map(row => row?.id));
  const log = path.join(base, 'unarchived-remote-sessions.jsonl');
  const restored = new Map();
  for (const row of rows(log)) {
    if (!row?.id) continue;
    const at = Date.parse(row.at);
    // 日時不明の復元記録も保護する。記録順ではなく最新の復元時刻と比較する。
    restored.set(row.id, Math.max(restored.get(row.id) ?? -Infinity, Number.isFinite(at) ? at : Infinity));
  }
  const result = { listed: 0, targets: 0, restored: 0, failed: 0, eventsFetched: 0 };
  if (dryRun) result.titles = [];
  const signal = () => AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now())));
  let cursor = '';
  for (let page = 0; page < 30; page++) {
    if (Date.now() >= deadline) return { ...result, limited: true };
    const q = new URLSearchParams({ limit: '100', ...(cursor && { cursor }) });
    const response = await fetchImpl(`${BASE}?${q}`, { headers: h, signal: signal() });
    if (!response.ok) return { ...result, error: `list ${response.status}` };
    const body = await response.json();
    result.listed += (body.data ?? []).length;
    for (const session of body.data ?? []) {
      if (Date.now() >= deadline) return { ...result, limited: true };
      if (!isCandidate(session, now) || archived.has(session.id)) continue;
      if (result.eventsFetched >= 150) return { ...result, limited: true };
      let events;
      try {
        result.eventsFetched++;
        const response = await fetchImpl(`${BASE}/${encodeURIComponent(session.id)}/events?limit=20`, { headers: h, signal: signal() });
        if (!response.ok) { result.failed++; continue; }
        events = (await response.json()).data ?? [];
      } catch { result.failed++; continue; }
      if (Date.now() >= deadline) return { ...result, limited: true };
      const exits = events.filter(e => e.event_type === 'system' && e.payload?.reason === 'host_exit');
      if (!hostExitArchive(events)) continue;
      if (restored.has(session.id) && !exits.some(e => Date.parse(e.created_at) > restored.get(session.id))) continue;
      // API は新しい順。過去の発言が closed に一致しても、最新の発言だけで判断する。
      const latest = events.find(e => ['user', 'assistant'].includes(e.payload?.type ?? e.event_type));
      if (index.has(latest?.payload?.uuid)) continue;
      const title = session.title.split('\n')[0].slice(0, 60);
      result.targets++;
      if (dryRun) { result.titles.push({ id: session.id, title }); continue; }
      try {
        const response = await fetchImpl(`${BASE}/${encodeURIComponent(session.id)}/unarchive`, {
          method: 'POST', headers: h, body: '{}', signal: signal(),
        });
        if (response.ok) {
          fs.appendFileSync(log, JSON.stringify({ id: session.id, title, reason: 'host_exit', status: response.status, at: new Date(now).toISOString() }) + '\n');
          restored.set(session.id, now);
          result.restored++;
        } else result.failed++;
      } catch { result.failed++; }
    }
    // has_more は返らない。空ページでも next_cursor があれば続行する。
    if (!body.next_cursor) break;
    cursor = body.next_cursor;
    if (page === 29) result.limited = true;
  }
  return result;
}

if (isEntry(import.meta.url)) {
  restoreRemote({ dryRun: process.argv.includes('--dry-run') })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
