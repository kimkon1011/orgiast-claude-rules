import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isCandidate, restoreRemote } from './restore-remote-sessions.mjs';

const now = Date.parse('2026-10-29T12:00:00Z');
const at = minutes => new Date(now - minutes * 60_000).toISOString();
const session = (extra = {}) => ({ id: 'cse_test', title: '作業中の会話', status: 'archived', updated_at: at(5), ...extra });
const exit = (created_at = at(5)) => ({ event_type: 'system', payload: { reason: 'host_exit' }, created_at });
const archive = (created_at = at(5)) => ({ payload: { request: { subtype: 'end_session', reason: 'archived' } }, created_at });
const message = (uuid, type = 'assistant') => ({ payload: { type, uuid } });
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'remote-restore-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const base = path.join(home, '.claude');
  const put = (name, value) => {
    const file = path.join(base, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
    return file;
  };
  put('.credentials.json', { claudeAiOauth: { accessToken: 'test' } });
  put('../.claude.json', { oauthAccount: { organizationUuid: 'org' } });
  put('closed-sessions.json', { ids: ['local'] });
  put('projects/project/local.jsonl', { type: 'user', uuid: 'closed' });
  return { base, put };
}
function mock({ sessions = [session()], events = [exit(), message('open')], status = 200, list } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, ...options });
    if (url.includes('/events?')) return typeof events === 'function' ? events(url) : reply({ data: events });
    if (url.endsWith('/unarchive')) {
      if (status === 'throw') throw new Error('network');
      return reply({}, status);
    }
    return list ? list(url) : reply({ data: sessions });
  };
  return { fetchImpl, calls };
}
const posts = calls => calls.filter(call => call.method === 'POST');

test('host_exit restores with authenticated empty-body POST and compatible log', async t => {
  const { base } = fixture(t);
  const { fetchImpl, calls } = mock();
  const result = await restoreRemote({ base, now, fetchImpl });
  assert.deepEqual(result, { listed: 1, targets: 1, restored: 1, failed: 0, eventsFetched: 1 });
  assert.equal(posts(calls).length, 1);
  const post = posts(calls)[0];
  assert.equal(post.url, 'https://api.anthropic.com/v1/code/sessions/cse_test/unarchive');
  assert.equal(post.body, '{}');
  assert.equal(post.headers.Authorization, 'Bearer test');
  assert.equal(post.headers['x-organization-uuid'], 'org');
  assert.equal(post.headers['anthropic-beta'], 'ccr-byoc-2025-07-29');
  assert.equal(calls[1].url.endsWith('/events?limit=20'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(base, 'unarchived-remote-sessions.jsonl'), 'utf8')),
    { id: 'cse_test', title: '作業中の会話', reason: 'host_exit', status: 200, at: at(0) });
});

for (const [label, offset, expected] of [
  ['ten minutes before archive', -600_000, 0],
  ['just before archive', -1_000, 1],
  ['two minute boundary', -120_000, 1],
  ['outside two minute boundary', -120_001, 0],
  ['same timestamp', 0, 1],
  ['one second clock tolerance', 1_000, 1],
  ['outside clock tolerance', 1_001, 0],
]) {
  test(`restore checks host_exit relative to latest archive: ${label}`, async t => {
    const { base } = fixture(t);
    const hostExit = exit(new Date(Date.parse(at(5)) + offset).toISOString());
    const events = [archive(), hostExit, message('open')].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
    const { fetchImpl, calls } = mock({ events });
    const result = await restoreRemote({ base, now, fetchImpl });
    assert.equal(result.targets, expected);
    assert.equal(result.restored, expected);
    assert.equal(result.failed, 0);
    assert.equal(posts(calls).length, expected);
    assert.equal(fs.existsSync(path.join(base, 'unarchived-remote-sessions.jsonl')), expected === 1);
  });
}

test('older automatic archive cannot override a later manual archive', async t => {
  const { base } = fixture(t);
  const { fetchImpl, calls } = mock({ events: [archive(), archive(at(15)), exit(at(15)), message('open')] });
  const result = await restoreRemote({ base, now, fetchImpl });
  assert.equal(result.restored, 0);
  assert.equal(result.failed, 0);
  assert.equal(posts(calls).length, 0);
});

test('only archived sessions updated within the last seven days are candidates', () => {
  assert.equal(isCandidate(session(), now), true);
  assert.equal(isCandidate(session({ updated_at: at(7 * 24 * 60) }), now), true);
  for (const extra of [{ status: 'idle' }, { updated_at: at(7 * 24 * 60 + 1) }, { updated_at: 'invalid' }, { updated_at: undefined }, { updated_at: at(-1) }]) {
    assert.equal(isCandidate(session(extra), now), false);
  }
});

test('empty and standby titles never fetch events', async t => {
  const { base } = fixture(t);
  const sessions = ['', '  ', null, undefined, 'remote-control-123', 'desktop-123', '会話なし（待機）'].map(title => session({ title }));
  const { fetchImpl, calls } = mock({ sessions });
  assert.equal((await restoreRemote({ base, now, fetchImpl })).eventsFetched, 0);
  assert.equal(calls.length, 1);
});

for (const events of [[], [message('open')], [{ event_type: 'user', payload: { reason: 'host_exit' } }], [{ event_type: 'system', payload: { reason: 'archived' } }]]) {
  test(`no system host_exit means no restore: ${JSON.stringify(events)}`, async t => {
    const { base } = fixture(t);
    const { fetchImpl, calls } = mock({ events });
    assert.equal((await restoreRemote({ base, now, fetchImpl })).restored, 0);
    assert.equal(posts(calls).length, 0);
  });
}

test('latest closed UUID is excluded; older closed UUID cannot override a newer open message', async t => {
  const { base } = fixture(t);
  for (const [events, expected] of [
    [[exit(), message('closed', 'user'), message('open')], 0],
    [[exit(), message('open'), message('closed')], 1],
    [[exit(), { event_type: 'assistant', payload: { uuid: 'closed' } }], 0],
  ]) {
    const { fetchImpl } = mock({ events });
    assert.equal((await restoreRemote({ base, now, fetchImpl, dryRun: true })).targets, expected);
  }
});

test('purge ledger IDs are excluded before fetching events', async t => {
  const { base, put } = fixture(t);
  put('archived-remote-sessions.jsonl', '{broken\n' + JSON.stringify({ id: 'cse_test', reason: 'closed' }) + '\n');
  const { fetchImpl, calls } = mock();
  assert.equal((await restoreRemote({ base, now, fetchImpl })).eventsFetched, 0);
  assert.equal(calls.length, 1);
});

for (const [createdAt, expected] of [[at(15), 0], [at(10), 0], ['invalid', 0], [at(5), 1]]) {
  test(`restored session needs a strictly newer host_exit: ${createdAt}`, async t => {
    const { base, put } = fixture(t);
    // 古い行が後ろにあっても最新の復元時刻を使う。
    const log = put('unarchived-remote-sessions.jsonl', [10, 20].map(minutes => JSON.stringify({ id: 'cse_test', at: at(minutes), status: 200 })).join('\n') + '\n');
    const { fetchImpl, calls } = mock({ events: [exit(createdAt), message('open')] });
    assert.equal((await restoreRemote({ base, now, fetchImpl })).restored, expected);
    assert.equal(posts(calls).length, expected);
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2 + expected);
  });
}

test('restoration without a usable timestamp remains protected', async t => {
  const { base, put } = fixture(t);
  put('unarchived-remote-sessions.jsonl', { id: 'cse_test' });
  const { fetchImpl, calls } = mock();
  assert.equal((await restoreRemote({ base, now, fetchImpl })).restored, 0);
  assert.equal(posts(calls).length, 0);
});

test('pagination uses next_cursor without has_more, including empty pages', async t => {
  const { base } = fixture(t);
  const { fetchImpl, calls } = mock({ list: url => {
    const q = new URL(url).searchParams;
    assert.equal(q.get('limit'), '100');
    if (!q.has('cursor')) return reply({ data: [session({ id: 'first' })], next_cursor: 'a+/=' });
    if (q.get('cursor') === 'a+/=') return reply({ data: [], next_cursor: 'last' });
    assert.equal(q.get('cursor'), 'last');
    return reply({ data: [session({ id: 'second' })] });
  } });
  const result = await restoreRemote({ base, now, fetchImpl });
  assert.equal(result.listed, 2);
  assert.equal(result.restored, 2);
  assert.equal(calls.filter(call => !call.url.includes('/sessions/')).length, 3);
});

test('dry-run ignores cooldown and lists titles without POST or any file writes', async t => {
  const { base, put } = fixture(t);
  put('restore-remote-sessions-state.json', { at: now });
  const snapshot = () => fs.readdirSync(base, { recursive: true }).filter(f => fs.statSync(path.join(base, f)).isFile())
    .map(f => [f, fs.readFileSync(path.join(base, f), 'utf8'), fs.statSync(path.join(base, f)).mtimeMs]);
  const before = snapshot();
  const { fetchImpl, calls } = mock();
  const result = await restoreRemote({ base, now, fetchImpl, dryRun: true });
  assert.deepEqual(result.titles, [{ id: 'cse_test', title: '作業中の会話' }]);
  assert.equal(result.targets, 1);
  assert.equal(result.restored, 0);
  assert.equal(posts(calls).length, 0);
  assert.deepEqual(snapshot(), before);
});

test('fifteen minute cooldown avoids requests and expires at the boundary', async t => {
  const { base, put } = fixture(t);
  put('restore-remote-sessions-state.json', { at: now });
  const { fetchImpl, calls } = mock();
  assert.deepEqual(await restoreRemote({ base, now: now + 15 * 60_000 - 1, fetchImpl }), { skipped: 'cooldown' });
  assert.equal(calls.length, 0);
  assert.equal((await restoreRemote({ base, now: now + 15 * 60_000, fetchImpl })).restored, 1);
});

test('events requests are capped at 150', async t => {
  const { base } = fixture(t);
  const { fetchImpl } = mock({ sessions: Array.from({ length: 151 }, (_, i) => session({ id: `cse_${i}` })) });
  const result = await restoreRemote({ base, now, fetchImpl, dryRun: true });
  assert.equal(result.eventsFetched, 150);
  assert.equal(result.targets, 150);
  assert.equal(result.limited, true);
});

test('pagination stops at thirty pages', async t => {
  const { base } = fixture(t);
  const { fetchImpl, calls } = mock({ list: () => reply({ data: [], next_cursor: 'more' }) });
  assert.equal((await restoreRemote({ base, now, fetchImpl })).limited, true);
  assert.equal(calls.length, 30);
});

test('deadline stops after event retrieval before POST', async t => {
  const { base } = fixture(t);
  let clock = now;
  t.mock.method(Date, 'now', () => clock);
  const { fetchImpl, calls } = mock({ events: () => { clock += 60_000; return reply({ data: [exit()] }); } });
  const result = await restoreRemote({ base, now, fetchImpl });
  assert.equal(result.limited, true);
  assert.equal(result.restored, 0);
  assert.equal(posts(calls).length, 0);
});

for (const failure of ['throw', 'http']) {
  test(`events ${failure} failure skips affected session and continues`, async t => {
    const { base } = fixture(t);
    const { fetchImpl } = mock({ sessions: [session({ id: 'bad' }), session()], events: url => {
      if (url.includes('/bad/')) {
        if (failure === 'throw') throw new Error('network');
        return reply({}, 500);
      }
      return reply({ data: [exit()] });
    } });
    const result = await restoreRemote({ base, now, fetchImpl });
    assert.equal(result.failed, 1);
    assert.equal(result.restored, 1);
  });
}

for (const status of [500, 409, 'throw']) {
  test(`failed unarchive (${status}) is not recorded as restored`, async t => {
    const { base } = fixture(t);
    const { fetchImpl } = mock({ status });
    const result = await restoreRemote({ base, now, fetchImpl });
    assert.equal(result.failed, 1);
    assert.equal(result.restored, 0);
    assert.equal(fs.existsSync(path.join(base, 'unarchived-remote-sessions.jsonl')), false);
  });
}

test('list HTTP errors produce a JSON-compatible result without restoring', async t => {
  const { base } = fixture(t);
  const { fetchImpl, calls } = mock({ list: () => reply({}, 401) });
  assert.equal((await restoreRemote({ base, now, fetchImpl })).error, 'list 401');
  assert.equal(calls.length, 1);
});
