#!/usr/bin/env node
// 明示的に閉じたセッションだけを claude.ai の「Code」一覧から退避する。
// アーカイブ後も会話はサーバーに残り、unarchive で復元できる。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { sessionApproved } from './purge-sessions.mjs';

const root = () => path.join(os.homedir(), '.claude');
const COOLDOWN = 6 * 3_600_000;
const IDLE = 10 * 60_000;
const TAIL = 512 * 1024;
const BASE = 'https://api.anthropic.com';
function json(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function text(row) {
  const c = row.message?.content;
  return typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text || '').join('\n') : '';
}
function entries(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } }
function rows(text) {
  return text.split('\n').flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
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
  const last = Date.parse(session.last_event_at ?? session.updated_at ?? session.created_at);
  return session.status !== 'archived' && session.connection_status === 'disconnected' && Number.isFinite(last) && now - last >= IDLE;
}

export function closedUuidIndex(base = root(), deadline = Infinity) {
  const ids = new Set(json(path.join(base, 'closed-sessions.json'), { ids: [] }).ids ?? []);
  // 帳簿の closed/approved は、ローカルでもまだ退避中のものだけ数える（--restore で再開したら対象外）。
  const archivedClosed = new Set();
  try {
    for (const row of rows(fs.readFileSync(path.join(base, 'archived-sessions.jsonl'), 'utf8'))) {
      if (row.reason === 'closed' || row.reason === 'approved') archivedClosed.add(row.sessionId);
    }
  } catch {}
  const index = new Map();
  for (const dir of ['projects', 'projects-archive']) {
    for (const project of entries(path.join(base, dir))) {
      if (!project.isDirectory()) continue;
      for (const file of entries(path.join(base, dir, project.name))) {
        if (Date.now() >= deadline) return index;
        if (!file.isFile() || !file.name.endsWith('.jsonl')) continue;
        const id = file.name.slice(0, -6);
        if (!ids.has(id) && !(dir === 'projects-archive' && archivedClosed.has(id))) continue;
        let fd;
        try {
          fd = fs.openSync(path.join(base, dir, project.name, file.name), 'r');
          const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL);
          const buffer = Buffer.alloc(Math.min(size, TAIL));
          const count = fs.readSync(fd, buffer, 0, buffer.length, start);
          let tail = buffer.subarray(0, count);
          // UTF-8 の途中から読んだ先頭行は、デコードする前に捨てる。
          if (start > 0) {
            const newline = tail.indexOf(10);
            tail = newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1);
          }
          const parsed = rows(tail.toString('utf8'));
          // 帳簿が closed でも、最後の発言の「このセッション:」行が閉じてよい以外（まだ閉じない等）なら対象外。
          const last = parsed.findLast((row) => row.type === 'assistant' && text(row));
          const footer = last ? text(last) : '';
          if (/^このセッション:/m.test(footer) && !sessionApproved(footer)) continue;
          for (const row of parsed) {
            if ((row.type === 'user' || row.type === 'assistant') && typeof row.uuid === 'string' && row.uuid) index.set(row.uuid, id);
          }
        } catch {} finally { if (fd !== undefined) fs.closeSync(fd); }
      }
    }
  }
  return index;
}

export function shouldArchive(newestUuid, index) { return typeof newestUuid === 'string' && !!newestUuid && index.has(newestUuid); }

export async function purgeRemote({ dryRun = false, fetchImpl = fetch, now = Date.now(), base = root() } = {}) {
  const deadline = Date.now() + 60_000;
  const stateFile = path.join(base, 'purge-remote-sessions-state.json');
  if (!dryRun && now - (json(stateFile).at ?? 0) < COOLDOWN) return { skipped: 'cooldown' };
  const h = headers(base);
  if (!h) return { skipped: 'no-credentials' };
  if (!dryRun) fs.writeFileSync(stateFile, JSON.stringify({ at: now }));
  const index = closedUuidIndex(base, deadline);
  const result = { listed: 0, targets: 0, archived: 0, failed: 0, eventsFetched: 0 };
  if (dryRun) result.titles = [];
  const signal = () => AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now())));
  const log = path.join(base, 'archived-remote-sessions.jsonl');
  let cursor = '';
  for (let page = 0; page < 30; page++) {
    if (Date.now() >= deadline) { result.limited = true; break; }
    const q = new URLSearchParams({ limit: '100', ...(cursor && { cursor }) });
    const r = await fetchImpl(`${BASE}/v1/code/sessions?${q}`, { headers: h, signal: signal() });
    if (!r.ok) return { ...result, error: `list ${r.status}` };
    const j = await r.json();
    result.listed += (j.data ?? []).length;
    for (const s of j.data ?? []) {
      if (Date.now() >= deadline || result.eventsFetched >= 150) return { ...result, limited: true };
      if (!isCandidate(s, now)) continue;
      let uuid;
      try {
        result.eventsFetched++;
        const events = await fetchImpl(`${BASE}/v1/code/sessions/${encodeURIComponent(s.id)}/events?limit=20`, { headers: h, signal: signal() });
        if (!events.ok) { result.failed++; continue; }
        const data = await events.json();
        // API は新しい順。古い一致メッセージまで遡って判定しない。
        uuid = (data.data ?? []).find((e) => (e.payload?.type === 'user' || e.payload?.type === 'assistant') && e.payload.uuid)?.payload.uuid;
      } catch { result.failed++; continue; }
      if (Date.now() >= deadline) return { ...result, limited: true };
      if (!shouldArchive(uuid, index)) continue;
      const localSessionId = index.get(uuid), title = (s.title ?? '').split('\n')[0].slice(0, 60);
      result.targets++;
      if (dryRun) { result.titles.push({ title, localSessionId }); continue; }
      try {
        const archived = await fetchImpl(`${BASE}/v1/code/sessions/${encodeURIComponent(s.id)}/archive`, { method: 'POST', headers: h, body: '{}', signal: signal() });
        if (archived.status === 200 || archived.status === 409) {
          result.archived++;
          fs.appendFileSync(log, JSON.stringify({ id: s.id, title, localSessionId, reason: 'closed', last: s.last_event_at, at: new Date(now).toISOString() }) + '\n');
        } else result.failed++;
      } catch { result.failed++; }
    }
    if (!j.next_cursor || !(j.data ?? []).length) break;
    cursor = j.next_cursor;
    if (page === 29) result.limited = true;
  }
  return result;
}

if (isEntry(import.meta.url)) {
  purgeRemote({ dryRun: process.argv.includes('--dry-run') })
    .then((r) => console.log(JSON.stringify(r)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
