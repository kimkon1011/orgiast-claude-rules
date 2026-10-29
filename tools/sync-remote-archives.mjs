#!/usr/bin/env node
// スマホ側で退避された Remote Control 会話を PC の退避帳簿へ写す。
// 導入前の archived は原因を区別できないので、初回の基準日時より前は永久に対象外。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { hostExitArchive } from './lib/host-exit-archive.mjs';

const COOLDOWN = 5 * 60_000;
const TAIL = 512 * 1024;
const API = 'https://api.anthropic.com/v1/code/sessions';
function json(file, fallback = {}) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }
function write(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}
function entries(dir) { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT') return []; throw e; } }
function headers(base) {
  const token = json(path.join(base, '.credentials.json')).claudeAiOauth?.accessToken;
  const org = json(path.join(base, '..', '.claude.json')).oauthAccount?.organizationUuid;
  if (!token || !org) return null;
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01',
    'anthropic-beta': 'ccr-byoc-2025-07-29', 'x-organization-uuid': org };
}
function readHead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const head = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0));
    const newline = head.indexOf(10);
    return JSON.parse(head.subarray(0, newline < 0 ? head.length : newline).toString('utf8'));
  } finally { fs.closeSync(fd); }
}
// UTF-8 の途中で切れた先頭行はデコード前に捨て、発言の時刻だけで再開を判定する。
export function resumedAfter(file, archivedAt) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size, start = Math.max(0, size - TAIL);
    const buffer = Buffer.alloc(Math.min(size, TAIL));
    let tail = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, start));
    if (start > 0) {
      const newline = tail.indexOf(10);
      tail = newline < 0 ? Buffer.alloc(0) : tail.subarray(newline + 1);
    }
    return tail.toString('utf8').split('\n').some(line => {
      let row; try { row = JSON.parse(line); } catch { return false; }
      return (row.type === 'user' || row.type === 'assistant') && Date.parse(row.timestamp) > archivedAt + 60_000;
    });
  } finally { fs.closeSync(fd); }
}

export async function syncRemoteArchives({ base = path.join(os.homedir(), '.claude'), now = Date.now(), fetchImpl = fetch, dryRun = false, since } = {}) {
  if (since !== undefined && (!dryRun || !Number.isFinite(Date.parse(since)))) throw new Error('--since requires --dry-run and an ISO date');
  const deadline = Date.now() + 60_000;
  const result = { listed: 0, candidates: 0, queued: 0, skippedHostExit: 0, skippedResumed: 0, skippedKept: 0, eventsFetched: 0, failed: 0 };
  if (dryRun) result.sessions = [];
  const stateFile = path.join(base, 'sync-remote-archives-state.json');
  const state = json(stateFile);
  const baseline = since !== undefined ? Date.parse(since) : (Number.isFinite(state.since) ? state.since : now);
  if (!dryRun && Number.isFinite(state.since) && now - (state.at ?? 0) < COOLDOWN) return { ...result, skipped: 'cooldown' };
  // 認証が未設定でも導入時刻は保存し、後日の初回接続で過去分を巻き込まない。
  if (!dryRun) { fs.mkdirSync(base, { recursive: true }); write(stateFile, { at: now, since: baseline }); }
  const h = headers(base);
  if (!h) return { ...result, skipped: 'no-credentials' };
  const index = new Map();
  for (const project of entries(path.join(base, 'projects'))) {
    if (!project.isDirectory() || project.name.startsWith('_')) continue;
    for (const entry of entries(path.join(base, 'projects', project.name))) {
      if (Date.now() >= deadline) return { ...result, limited: true };
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(base, 'projects', project.name, entry.name);
      try {
        const head = readHead(file);
        if (head.type !== 'bridge-session' || !head.bridgeSessionId || head.sessionId !== entry.name.slice(0, -6)) continue;
        index.set(head.bridgeSessionId, { projectId: project.name, localSessionId: head.sessionId, file });
      } catch { /* 通常会話や不完全な先頭行は同期しない。 */ }
    }
  }
  const ledgerFile = path.join(base, 'remote-archived-sessions.json');
  const signal = () => AbortSignal.timeout(Math.max(1, Math.min(10_000, deadline - Date.now())));
  let cursor = '';
  for (let page = 0; page < 30; page++) {
    if (Date.now() >= deadline) return { ...result, limited: true };
    let body;
    try {
      const q = new URLSearchParams({ limit: '100', ...(cursor && { cursor }) });
      const response = await fetchImpl(`${API}?${q}`, { headers: h, signal: signal() });
      if (!response.ok) { result.failed++; return result; }
      body = await response.json();
    } catch { result.failed++; return result; }
    result.listed += (body.data ?? []).length;
    for (const session of body.data ?? []) {
      if (Date.now() >= deadline) return { ...result, limited: true };
      const local = index.get(session.id);
      if (!local || session.status !== 'archived' || !(Date.parse(session.updated_at) >= baseline)) continue;
      result.candidates++;
      if (result.eventsFetched >= 100) return { ...result, limited: true };
      try {
        result.eventsFetched++;
        const response = await fetchImpl(`${API}/${encodeURIComponent(session.id)}/events?limit=30`, { headers: h, signal: signal() });
        if (!response.ok) { result.failed++; continue; }
        const events = await response.json();
        const event = (events.data ?? []).find(e => e.payload?.request?.subtype === 'end_session' && e.payload.request.reason === 'archived');
        const archivedAt = Date.parse(event?.created_at);
        if (!(archivedAt >= baseline)) continue;
        // PC 側終了で本体が自動アーカイブしたものは restore-remote-sessions が戻すので、ローカルも退避しない。
        if (hostExitArchive(events.data ?? [])) { result.skippedHostExit++; continue; }
        if (Date.now() >= deadline) return { ...result, limited: true };
        if (resumedAfter(local.file, archivedAt)) { result.skippedResumed++; continue; }
        // 書き込み直前に読み直し、復元済み ID や他の同期が追加した項目を保持する。
        const latest = json(ledgerFile, { ids: [], kept: [] });
        // 復元した会話は、復元より後にもう一度アーカイブされたときだけ再び対象にする（keptAt が無い旧形式は永久保護）。
        const keptAt = Date.parse(latest.keptAt?.[local.localSessionId]);
        if ((latest.kept ?? []).includes(local.localSessionId) && !(archivedAt > keptAt)) { result.skippedKept++; continue; }
        if ((latest.ids ?? []).some(row => row.sessionId === local.localSessionId)) continue;
        const row = { sessionId: local.localSessionId, projectId: local.projectId, bridgeSessionId: session.id, archivedAt: event.created_at, title: session.title ?? '' };
        const { [local.localSessionId]: _released, ...restKeptAt } = latest.keptAt ?? {};
        if (dryRun) result.sessions.push({ title: row.title, localSessionId: row.sessionId, archivedAt: row.archivedAt });
        else write(ledgerFile, { ...latest, ids: [...(latest.ids ?? []), row],
          kept: (latest.kept ?? []).filter(id => id !== local.localSessionId), keptAt: restKeptAt });
        result.queued++;
      } catch { result.failed++; }
    }
    if (!body.next_cursor || !(body.data ?? []).length) break;
    cursor = body.next_cursor;
    if (page === 29) result.limited = true;
  }
  return result;
}

if (isEntry(import.meta.url)) {
  const i = process.argv.indexOf('--since');
  const since = i < 0 ? undefined : process.argv[i + 1] ?? '';
  syncRemoteArchives({ dryRun: process.argv.includes('--dry-run'), since })
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
