import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncRemoteArchives } from './sync-remote-archives.mjs';

const now = Date.parse('2026-10-28T03:00:00Z');
const iso = offset => new Date(now + offset).toISOString();
const reply = (data, status = 200) => ({ ok: status === 200, status, json: async () => data });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-sync-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude');
  const put = (name, data) => {
    const file = path.join(base, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data)); return file;
  };
  put('.credentials.json', { claudeAiOauth: { accessToken: 'test' } });
  put('../.claude.json', { oauthAccount: { organizationUuid: 'org' } });
  const session = (id, rows = [], project = 'p') => put(`projects/${project}/${id}.jsonl`,
    [{ type: 'bridge-session', sessionId: id, bridgeSessionId: `cse_${id}` }, ...rows].map(JSON.stringify).join('\n') + '\n');
  const state = () => put('sync-remote-archives-state.json', { at: now - 600_000, since: now - 300_000 });
  const read = name => JSON.parse(fs.readFileSync(path.join(base, name), 'utf8'));
  const calls = [];
  const server = (sessions, archived = iso(-120_000)) => async (url, options) => {
    calls.push(url);
    assert.equal(options.headers['anthropic-beta'], 'ccr-byoc-2025-07-29');
    assert.ok(options.signal instanceof AbortSignal);
    return reply({ data: url.includes('/events?') ? [{ created_at: archived, payload: { request: { subtype: 'end_session', reason: 'archived' } } }] : sessions });
  };
  const remote = (id, status = 'archived', updated_at = iso(-60_000)) => ({ id: `cse_${id}`, title: `会話 ${id}`, status, updated_at });
  return { base, put, session, state, read, server, remote, calls };
}

test('archives after since are queued once; baseline survives cooldown and subsequent runs', async t => {
  const f = fixture(t); f.state(); f.session('a');
  const options = { base: f.base, now, fetchImpl: f.server([f.remote('a')]) };
  assert.equal((await syncRemoteArchives(options)).queued, 1);
  assert.deepEqual(f.read('remote-archived-sessions.json'), { ids: [{ sessionId: 'a', projectId: 'p', bridgeSessionId: 'cse_a', archivedAt: iso(-120_000), title: '会話 a' }], kept: [], keptAt: {} });
  assert.equal((await syncRemoteArchives(options)).skipped, 'cooldown');
  assert.equal((await syncRemoteArchives({ ...options, now: now + 600_000 })).queued, 0);
  assert.equal(f.read('sync-remote-archives-state.json').since, now - 300_000);
});

test('first invocation fixes since=now and permanently excludes older archives', async t => {
  const f = fixture(t); f.session('a');
  const fetchImpl = f.server([f.remote('a', 'archived', iso(1))], iso(-1));
  assert.equal((await syncRemoteArchives({ base: f.base, now, fetchImpl })).queued, 0);
  assert.deepEqual(f.read('sync-remote-archives-state.json'), { at: now, since: now });
  assert.equal((await syncRemoteArchives({ base: f.base, now: now + 600_000, fetchImpl })).queued, 0);
  assert.equal(fs.existsSync(path.join(f.base, 'remote-archived-sessions.json')), false);
});

test('active, old updated_at, unmatched, excluded projects and already archived files need no events', async t => {
  const f = fixture(t); f.state(); f.session('active'); f.session('old'); f.session('excluded', [], '_hidden');
  f.put('projects-archive/p/archived.jsonl', JSON.stringify({ type: 'bridge-session', sessionId: 'archived', bridgeSessionId: 'cse_archived' }));
  const r = await syncRemoteArchives({ base: f.base, now, fetchImpl: f.server([f.remote('active', 'active'), f.remote('old', 'archived', iso(-600_000)), f.remote('missing'), f.remote('excluded'), f.remote('archived')]) });
  assert.equal(r.eventsFetched, 0); assert.equal(r.listed, 5);
});

test('user and assistant activity after grace period is skipped, including a UTF-8 tail cut', async t => {
  const f = fixture(t); f.state();
  for (const type of ['user', 'assistant']) f.session(type, [{ type: 'system', padding: 'あ'.repeat(200_000) }, { type, timestamp: iso(-59_999) }]);
  f.session('boundary', [{ type: 'user', timestamp: iso(-60_000) }]);
  const r = await syncRemoteArchives({ base: f.base, now, fetchImpl: f.server(['user', 'assistant', 'boundary'].map(id => f.remote(id))) });
  assert.equal(r.skippedResumed, 2); assert.equal(r.queued, 1);
  assert.equal(f.read('remote-archived-sessions.json').ids[0].sessionId, 'boundary');
});

test('a restored session is queued again only when archived after the restore', async t => {
  const f = fixture(t); f.state(); f.session('old'); f.session('new');
  f.put('remote-archived-sessions.json', { ids: [], kept: ['old', 'new'], keptAt: { old: iso(-60_000), new: iso(-300_000) } });
  const r = await syncRemoteArchives({ base: f.base, now, fetchImpl: f.server([f.remote('old'), f.remote('new')]) });
  assert.equal(r.skippedKept, 1); assert.equal(r.queued, 1);
  const ledger = f.read('remote-archived-sessions.json');
  assert.deepEqual(ledger.ids.map(row => row.sessionId), ['new']);
  assert.deepEqual(ledger.kept, ['old']); assert.deepEqual(Object.keys(ledger.keptAt), ['old']);
});

test('kept is reread after events and concurrent additions survive', async t => {
  const f = fixture(t); f.state(); f.session('a'); f.session('b');
  const remote = f.server([f.remote('a'), f.remote('b')]);
  const fetchImpl = async (url, options) => {
    if (url.includes('cse_a/events')) f.put('remote-archived-sessions.json', { ids: [{ sessionId: 'other' }], kept: ['a'], metadata: true });
    return remote(url, options);
  };
  const r = await syncRemoteArchives({ base: f.base, now, fetchImpl });
  assert.equal(r.skippedKept, 1); assert.equal(r.queued, 1);
  assert.deepEqual(f.read('remote-archived-sessions.json').ids.map(row => row.sessionId), ['other', 'b']);
  assert.equal(f.read('remote-archived-sessions.json').metadata, true);
});

test('dry-run with since override writes neither state nor ledger', async t => {
  const f = fixture(t); f.session('a');
  const r = await syncRemoteArchives({ base: f.base, now, dryRun: true, since: iso(-300_000), fetchImpl: f.server([f.remote('a')]) });
  assert.deepEqual(r.sessions, [{ title: '会話 a', localSessionId: 'a', archivedAt: iso(-120_000) }]);
  for (const file of ['sync-remote-archives-state.json', 'remote-archived-sessions.json']) assert.equal(fs.existsSync(path.join(f.base, file)), false);
  await assert.rejects(syncRemoteArchives({ base: f.base, now, since: iso(-300_000) }), /--dry-run/);
  await assert.rejects(syncRemoteArchives({ base: f.base, now, dryRun: true, since: 'invalid' }), /ISO/);
});

test('pagination follows cursor; newest archive event wins and missing or invalid dates fail closed', async t => {
  const f = fixture(t); f.state(); for (const id of ['a', 'b', 'c']) f.session(id);
  const event = created_at => ({ created_at, payload: { request: { subtype: 'end_session', reason: 'archived' } } });
  const fetchImpl = async url => {
    if (url.includes('cse_a/events')) return reply({ data: [event(iso(-120_000)), event(iso(-600_000))] });
    if (url.includes('cse_b/events')) return reply({ data: [event('bad date')] });
    if (url.includes('cse_c/events')) return reply({ data: [] });
    return reply(url.includes('cursor=next') ? { data: [f.remote('b'), f.remote('c')] } : { data: [f.remote('a')], next_cursor: 'next' });
  };
  const r = await syncRemoteArchives({ base: f.base, now, fetchImpl });
  assert.equal(r.listed, 3); assert.equal(r.queued, 1); assert.equal(r.eventsFetched, 3);
});

test('events budget is capped at 100 and HTTP/network failures are counted', async t => {
  const f = fixture(t); f.state();
  const sessions = Array.from({ length: 101 }, (_, i) => { f.session(String(i)); return f.remote(String(i)); });
  const r = await syncRemoteArchives({ base: f.base, now, fetchImpl: f.server(sessions) });
  assert.equal(r.eventsFetched, 100); assert.equal(r.limited, true);
  for (const fetchImpl of [async () => reply({}, 500), async () => { throw new Error('offline'); }, async url => url.includes('/events?') ? reply({}, 503) : reply({ data: [sessions[0]] })]) {
    const result = await syncRemoteArchives({ base: f.base, now, dryRun: true, fetchImpl });
    assert.equal(result.failed, 1);
  }
});

test('60-second deadline stops before ledger write and pagination stops at 30 pages', async t => {
  const f = fixture(t); f.state(); f.session('a');
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const server = f.server([f.remote('a')]);
  const r = await syncRemoteArchives({ base: f.base, now, fetchImpl: async (url, options) => {
    if (url.includes('/events?')) clock += 60_000;
    return server(url, options);
  } });
  assert.equal(r.limited, true); assert.equal(r.queued, 0);
  assert.equal(fs.existsSync(path.join(f.base, 'remote-archived-sessions.json')), false);
  let pages = 0;
  const paged = await syncRemoteArchives({ base: f.base, now, dryRun: true, fetchImpl: async () => {
    pages++; return reply({ data: [f.remote('a', 'active')], next_cursor: `page-${pages}` });
  } });
  assert.equal(pages, 30); assert.equal(paged.limited, true);
});
