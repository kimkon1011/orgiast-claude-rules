import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCandidate, closedUuidIndex, shouldArchive, purgeRemote } from './purge-remote-sessions.mjs';

const now = Date.parse('2026-10-22T12:00:00Z');
const at = (minutes) => new Date(now - minutes * 60_000).toISOString();
const session = (extra = {}) => ({ id: 'cse_test', title: 'タイトル', status: 'active', connection_status: 'disconnected', last_event_at: at(10), ...extra });
const event = (uuid) => ({ payload: { type: 'assistant', uuid } });
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
function fixture(t, { reason, dir = 'projects' } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-purge-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude');
  const project = path.join(base, dir, 'project');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'test' } }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'org' } }));
  fs.writeFileSync(path.join(base, reason ? 'archived-sessions.jsonl' : 'closed-sessions.json'), JSON.stringify(reason ? { sessionId: 'local', reason } : { ids: ['local'] }));
  const transcript = path.join(project, 'local.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', uuid: 'match' }) + '\n');
  return { base, transcript };
}
function mock(sessions = [session()], events = [event('match')], archiveStatus = 200) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    if (url.includes('/events?')) return typeof events === 'function' ? events(url) : reply({ data: events });
    if (url.endsWith('/archive')) return reply({}, archiveStatus);
    return reply({ data: sessions });
  };
  return { calls, fetchImpl };
}

test('candidate requires disconnected, unarchived and idle >= 10 minutes', () => {
  assert.equal(isCandidate(session(), now), true);
  for (const s of [session({ last_event_at: at(9) }), session({ connection_status: 'connected' }), session({ status: 'archived' }), session({ last_event_at: 'invalid' })]) assert.equal(isCandidate(s, now), false);
  assert.equal(isCandidate(session({ last_event_at: undefined, updated_at: at(10) }), now), true);
  assert.equal(isCandidate(session({ last_event_at: undefined, created_at: at(10) }), now), true);
  assert.equal(isCandidate(session({ last_event_at: undefined }), now), false);
});

for (const reason of [undefined, 'closed', 'approved', 'abandoned', 'empty']) {
  test(`closed source ${reason ?? 'closed-sessions.json'} controls archive and log`, async (t) => {
    const { base } = fixture(t, { reason, dir: reason ? 'projects-archive' : 'projects' });
    const { fetchImpl, calls } = mock();
    const result = await purgeRemote({ base, now, fetchImpl });
    const expected = reason === 'abandoned' || reason === 'empty' ? 0 : 1;
    assert.equal(result.archived, expected);
    assert.equal(calls.filter((c) => c.method === 'POST').length, expected);
    const log = path.join(base, 'archived-remote-sessions.jsonl');
    if (expected) {
      const row = JSON.parse(fs.readFileSync(log, 'utf8'));
      assert.equal(row.localSessionId, 'local');
      assert.equal(row.reason, 'closed');
    } else assert.equal(fs.existsSync(log), false);
  });
}

test('closed ledger is overridden when the last footer says the session is still open', async (t) => {
  const { base, transcript } = fixture(t);
  const footer = (value) => JSON.stringify({ type: 'assistant', uuid: 'match', message: { content: [{ type: 'text', text: `本文\nこのセッション: ${value}` }] } }) + '\n';
  fs.writeFileSync(transcript, footer('まだ閉じない（作業中）'));
  let mocked = mock();
  assert.equal((await purgeRemote({ base, now, fetchImpl: mocked.fetchImpl })).archived, 0);
  fs.rmSync(path.join(base, 'purge-remote-sessions-state.json'));
  fs.writeFileSync(transcript, footer('/session-close は終わっているので、このセッションを閉じてよい'));
  mocked = mock();
  assert.equal((await purgeRemote({ base, now, fetchImpl: mocked.fetchImpl })).archived, 1);
});

test('closed ledger row no longer counts after the transcript was restored to projects', async (t) => {
  const { base } = fixture(t, { reason: 'closed', dir: 'projects' });
  const { fetchImpl, calls } = mock();
  assert.equal((await purgeRemote({ base, now, fetchImpl })).archived, 0);
  assert.equal(calls.some((c) => c.method === 'POST'), false);
});

for (const events of [[event('later'), event('match')], [], [{ payload: { type: 'system', uuid: 'match' } }], [{ payload: { type: 'user' } }]]) {
  test(`unmatched or missing latest uuid keeps session: ${JSON.stringify(events)}`, async (t) => {
    const { base } = fixture(t);
    const { fetchImpl, calls } = mock([session()], events);
    assert.equal((await purgeRemote({ base, now, fetchImpl })).archived, 0);
    assert.equal(calls.some((c) => c.method === 'POST'), false);
  });
}

test('non-candidates never fetch events', async (t) => {
  const { base } = fixture(t);
  const { fetchImpl, calls } = mock([session({ connection_status: 'connected' }), session({ last_event_at: at(9) }), session({ status: 'archived' })]);
  assert.equal((await purgeRemote({ base, now, fetchImpl })).archived, 0);
  assert.equal(calls.length, 1);
});

for (const failure of ['throw', 'http']) {
  test(`events ${failure} failure keeps session and continues`, async (t) => {
    const { base } = fixture(t);
    const { fetchImpl, calls } = mock([session({ id: 'bad' }), session()], (url) => {
      if (url.includes('/bad/')) {
        if (failure === 'throw') throw new Error('network');
        return reply({}, 500);
      }
      return reply({ data: [event('match')] });
    });
    const result = await purgeRemote({ base, now, fetchImpl });
    assert.equal(result.archived, 1);
    assert.equal(result.failed, 1);
    assert.equal(calls.filter((c) => c.method === 'POST').length, 1);
  });
}

test('dry-run prints matching title and local id without POST or writes', async (t) => {
  const { base } = fixture(t);
  const state = path.join(base, 'purge-remote-sessions-state.json');
  fs.writeFileSync(state, JSON.stringify({ at: now }));
  const snapshot = () => fs.readdirSync(base, { recursive: true }).filter((f) => fs.statSync(path.join(base, f)).isFile()).map((f) => [f, fs.readFileSync(path.join(base, f), 'utf8'), fs.statSync(path.join(base, f)).mtimeMs]);
  const before = snapshot();
  const { fetchImpl, calls } = mock();
  const result = await purgeRemote({ base, now, fetchImpl, dryRun: true });
  assert.deepEqual(result.titles, [{ title: 'タイトル', localSessionId: 'local' }]);
  assert.equal(calls.some((c) => c.method === 'POST'), false);
  assert.deepEqual(snapshot(), before);
});

test('409 is logged as archived and six-hour cooldown prevents requests', async (t) => {
  const { base } = fixture(t);
  const { fetchImpl, calls } = mock([session()], [event('match')], 409);
  assert.equal((await purgeRemote({ base, now, fetchImpl })).archived, 1);
  const count = calls.length;
  assert.deepEqual(await purgeRemote({ base, now: now + 60_000, fetchImpl }), { skipped: 'cooldown' });
  assert.equal(calls.length, count);
});

test('events fetches are capped at 150', async (t) => {
  const { base } = fixture(t);
  const { fetchImpl, calls } = mock(Array.from({ length: 151 }, (_, i) => session({ id: `cse_${i}` })));
  const result = await purgeRemote({ base, now, fetchImpl, dryRun: true });
  assert.equal(result.eventsFetched, 150);
  assert.equal(result.limited, true);
  assert.equal(calls.filter((c) => c.url.includes('/events?')).length, 150);
});

test('index reads only complete tail lines and user/assistant UUIDs', (t) => {
  const { base, transcript } = fixture(t);
  const row = (type, uuid, text = '') => JSON.stringify({ type, uuid, text }) + '\n';
  fs.writeFileSync(transcript, row('user', 'old') + row('user', 'partial', 'あ'.repeat(200_000)) + row('system', 'ignored') + 'broken\n' + row('assistant', 'match'));
  const index = closedUuidIndex(base);
  assert.deepEqual([...index], [['match', 'local']]);
  assert.equal(shouldArchive('match', index), true);
  assert.equal(shouldArchive(undefined, index), false);
  fs.unlinkSync(transcript);
  assert.equal(closedUuidIndex(base).size, 0);
});

test('runtime budget stops before POST and remaining events requests', async (t) => {
  const { base } = fixture(t);
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const { fetchImpl, calls } = mock([session(), session({ id: 'next' })], () => {
    clock += 60_000;
    return reply({ data: [event('match')] });
  });
  const result = await purgeRemote({ base, now, fetchImpl });
  assert.equal(result.limited, true);
  assert.equal(result.archived, 0);
  assert.equal(result.eventsFetched, 1);
  assert.equal(calls.some((c) => c.method === 'POST'), false);
});
