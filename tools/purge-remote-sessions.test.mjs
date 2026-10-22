import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isStale, closedRemoteIds, selectTargets } from './purge-remote-sessions.mjs';

const now = Date.parse('2026-10-15T12:00:00Z');
const at = (hours) => new Date(now - hours * 3_600_000).toISOString();

test('archives only active, disconnected sessions idle for 24h or more', () => {
  assert.equal(isStale({ status: 'active', connection_status: 'disconnected', last_event_at: at(25) }, now), true);
  assert.equal(isStale({ status: 'active', connection_status: 'disconnected', last_event_at: at(23) }, now), false);
  assert.equal(isStale({ status: 'active', connection_status: 'connected', last_event_at: at(100) }, now), false);
  assert.equal(isStale({ status: 'archived', connection_status: 'disconnected', last_event_at: at(100) }, now), false);
  assert.equal(isStale({ status: 'active', connection_status: 'disconnected', updated_at: at(48) }, now), true);
  assert.equal(isStale({ status: 'active', connection_status: 'disconnected' }, now), false);
});

// Temp layout mirroring ~/.claude: projects/ (live), projects-archive/ (purged), current-sessions/.
function fixture(files) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'purge-remote-'));
  for (const [rel, bridge] of Object.entries(files)) {
    const full = path.join(base, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bridge ? `{"type":"bridge-session","sessionId":"x","bridgeSessionId":"${bridge}"}\n` : '{"type":"user","message":"hi"}\n');
  }
  fs.mkdirSync(path.join(base, 'projects'), { recursive: true });
  fs.mkdirSync(path.join(base, 'projects-archive'), { recursive: true });
  fs.mkdirSync(path.join(base, 'current-sessions'), { recursive: true });
  return base;
}

const write = (base, rel, body = '{"type":"user"}\n') => {
  const full = path.join(base, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
};

test('closedRemoteIds returns only cse ids whose transcript is already in projects-archive', () => {
  const base = fixture({});
  write(base, 'projects-archive/p1/aaaa.jsonl', '{"type":"bridge-session","bridgeSessionId":"cse_closed"}\n');
  write(base, 'projects/p1/bbbb.jsonl', '{"type":"bridge-session","bridgeSessionId":"cse_live"}\n');
  write(base, 'projects-archive/p1/cccc.jsonl', 'no bridge line here\n');
  const closed = closedRemoteIds({ base });
  assert.deepEqual([...closed.keys()], ['cse_closed']);
  assert.equal(closed.get('cse_closed'), 'aaaa');
});

test('a cse id that still has a live transcript is never treated as closed', () => {
  const base = fixture({});
  write(base, 'projects-archive/p1/aaaa.jsonl', '{"type":"bridge-session","bridgeSessionId":"cse_moved_back"}\n');
  write(base, 'projects/p1/aaaa.jsonl', '{"type":"bridge-session","bridgeSessionId":"cse_moved_back"}\n');
  assert.equal(closedRemoteIds({ base }).has('cse_moved_back'), false);
});

test('restored sessions in current-sessions are protected even if archived copy remains', () => {
  const base = fixture({});
  write(base, 'projects-archive/p1/aaaa.jsonl', '{"type":"bridge-session","bridgeSessionId":"cse_restored"}\n');
  write(base, 'current-sessions/aaaa.json', '{"sessionId":"aaaa"}');
  assert.equal(closedRemoteIds({ base }).has('cse_restored'), false);
});

test('selectTargets archives stale sessions only when a local close record exists', () => {
  const sessions = [
    { id: 'cse_closed', status: 'active', connection_status: 'disconnected', last_event_at: at(30) },
    { id: 'cse_unlinked', status: 'active', connection_status: 'disconnected', last_event_at: at(30) },
    { id: 'cse_fresh', status: 'active', connection_status: 'disconnected', last_event_at: at(2) },
    { id: 'cse_connected', status: 'active', connection_status: 'connected', last_event_at: at(30) },
  ];
  const { stale, targets } = selectTargets(sessions, new Map([['cse_closed', 'local']]), now);
  assert.deepEqual(stale.map((s) => s.id), ['cse_closed', 'cse_unlinked']);
  assert.deepEqual(targets.map((s) => s.id), ['cse_closed']);
});

test('purgeRemote posts archive only for sessions linked to a locally archived transcript', async () => {
  const { purgeRemote } = await import('./purge-remote-sessions.mjs');
  const base = fixture({});
  write(base, 'projects-archive/p1/aaaa.jsonl', '{"type":"bridge-session","bridgeSessionId":"cse_closed"}\n');
  write(base, 'projects/p1/bbbb.jsonl', '{"type":"bridge-session","bridgeSessionId":"cse_open"}\n');
  const sessions = [
    { id: 'cse_closed', title: 'done on this PC', status: 'active', connection_status: 'disconnected', last_event_at: at(30) },
    { id: 'cse_open', title: 'still open', status: 'active', connection_status: 'disconnected', last_event_at: at(30) },
    { id: 'cse_mobile', title: 'mobile only', status: 'active', connection_status: 'disconnected', last_event_at: at(30) },
  ];
  const posted = [];
  const fetchImpl = async (url, init) => {
    if (url.includes('/archive')) { posted.push(url); return { ok: true, status: 200, json: async () => ({}) }; }
    return { ok: true, status: 200, json: async () => ({ data: sessions }) };
  };
  const r = await purgeRemote({ base, fetchImpl, now, headersImpl: () => ({ Authorization: 't' }) });
  assert.equal(r.listed, 3);
  assert.equal(r.stale, 3);
  assert.equal(r.targets, 1);
  assert.equal(r.unlinked, 2);
  assert.equal(r.archived, 1);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /cse_closed\/archive/);
  const log = fs.readFileSync(path.join(base, 'archived-remote-sessions.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(log.map((e) => [e.id, e.localId, e.reason]), [['cse_closed', 'aaaa', 'closed-locally']]);
});

test('dry-run reports what would happen without writing the cooldown state or log', async () => {
  const { purgeRemote } = await import('./purge-remote-sessions.mjs');
  const base = fixture({});
  write(base, 'projects-archive/p1/aaaa.jsonl', '{"type":"bridge-session","bridgeSessionId":"cse_closed"}\n');
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'cse_closed', title: 'x', status: 'active', connection_status: 'disconnected', last_event_at: at(30) }] }) });
  const r = await purgeRemote({ dryRun: true, base, fetchImpl, now, headersImpl: () => ({}) });
  assert.deepEqual([r.listed, r.stale, r.targets, r.unlinked, r.archived], [1, 1, 1, 0, 0]);
  assert.deepEqual(r.titles, ['x']);
  assert.equal(fs.existsSync(path.join(base, 'purge-remote-sessions-state.json')), false);
  assert.equal(fs.existsSync(path.join(base, 'archived-remote-sessions.jsonl')), false);
});

test('a future stop marker (manual pause) no longer blocks the resumed run', async () => {
  const { purgeRemote } = await import('./purge-remote-sessions.mjs');
  const base = fixture({});
  fs.writeFileSync(path.join(base, 'purge-remote-sessions-state.json'), JSON.stringify({ at: now + 100 * 3_600_000, note: 'paused' }));
  let called = false;
  const r = await purgeRemote({ base, now, headersImpl: () => ({}), fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({ data: [] }) }; } });
  assert.equal(called, true);
  assert.equal(r.listed, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'purge-remote-sessions-state.json'), 'utf8')).at, now);
});

test('cooldown blocks a second run within six hours', async () => {
  const { purgeRemote } = await import('./purge-remote-sessions.mjs');
  const base = fixture({});
  fs.writeFileSync(path.join(base, 'purge-remote-sessions-state.json'), JSON.stringify({ at: now - 3_600_000 }));
  let called = false;
  const r = await purgeRemote({ base, now, headersImpl: () => ({}), fetchImpl: async () => { called = true; return { ok: true, status: 200, json: async () => ({ data: [] }) }; } });
  assert.deepEqual(r, { skipped: 'cooldown' });
  assert.equal(called, false);
});
