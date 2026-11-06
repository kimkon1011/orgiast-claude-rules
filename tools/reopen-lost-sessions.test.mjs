import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hasConversation, hasHostExit, exclusion, parseAgents, parseOptions, localIndex, acquireLock, reopenLost, watchReopen } from './reopen-lost-sessions.mjs';

const since = '2026-11-05T19:40:00Z', until = '2026-11-05T20:15:00Z';
const exit = { event_type: 'system', payload: { reason: 'host_exit' }, created_at: since };

test('host exit interval inclusive; excludes wrong reason/type/time', () => {
  assert.equal(hasHostExit([exit], since, until), true);
  assert.equal(hasHostExit([{ ...exit, created_at: until }], since, until), true);
  for (const row of [{ ...exit, created_at: '2020-01-01' }, { ...exit, event_type: 'user' }, { ...exit, payload: {} }]) assert.equal(hasHostExit([row], since, until), false);
});

test('purge compatible empty detection and exclusions', () => {
  for (const marker of ['command-name', 'local-command-caveat', 'command-message']) assert.equal(hasConversation([{ type: 'user', message: { content: `<${marker}>` } }]), false);
  assert.equal(hasConversation([{ type: 'assistant', message: { content: [{ text: 'answer' }] } }]), true);
  assert.equal(hasConversation([], 204801), true);
  const local = { id: 'one', cwd: 'C:\\work', hasConversation: true };
  assert.equal(exclusion(local, new Set(), new Set()), null);
  assert.equal(exclusion(local, new Set(['one']), new Set()), 'closed');
  assert.equal(exclusion(local, new Set(), new Set(['one'])), 'alive');
  assert.equal(exclusion({ ...local, hasConversation: false }, new Set(), new Set()), 'empty');
  assert.equal(exclusion(null, new Set(), new Set()), 'noLocal');
  for (const raw of ['', '{}', '[{}]']) assert.throws(() => parseAgents(raw));
  assert.deepEqual([...parseAgents('[]')], []);
});

test('CLI validation and default boot range', () => {
  assert.throws(() => parseOptions(['--max', '-1']));
  assert.throws(() => parseOptions(['--since', 'bad', '--until', until]));
  const o = parseOptions([], () => ({ status: 0, stdout: '2026-11-05T20:00:00Z' }));
  assert.equal(o.since, '2026-11-05T19:45:00.000Z');
  assert.equal(o.until, '2026-11-05T20:15:00.000Z');
});

test('parseOptions watch mode mutual exclusivity', () => {
  assert.throws(() => parseOptions(['--watch', '--since', '2026-11-05T00:00:00Z']));
  assert.throws(() => parseOptions(['--watch', '--until', '2026-11-05T00:00:00Z']));
  const opts = parseOptions(['--watch', '--max', '5']);
  assert.equal(opts.watch, true);
  assert.equal(opts.max, 5);
  assert.equal(opts.maxSet, true);
});

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.claude');
  fs.mkdirSync(path.join(base, 'projects', 'proj'), { recursive: true });
  fs.writeFileSync(path.join(base, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'mock' } }));
  fs.writeFileSync(path.join(root, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'mock' } }));
  fs.writeFileSync(path.join(base, 'projects', 'proj', 'one.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_one' },
    { type: 'user', cwd: 'C:\\work', message: { content: 'hello' } },
  ].map(JSON.stringify).join('\n'));
  return base;
}

test('localIndex uses first cwd when transcript has multiple cwd lines', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reopen-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, '.claude', 'projects', 'proj');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(path.join(projects, 'multi.jsonl'), [
    { type: 'bridge-session', bridgeSessionId: 'cse_multi' },
    { type: 'user', cwd: 'C:\\start\\cwd', message: { content: 'first' } },
    { type: 'user', cwd: 'C:\\worktree\\later', message: { content: 'second' } },
  ].map(JSON.stringify).join('\n'));
  const idx = localIndex(path.join(root, '.claude'));
  assert.equal(idx.size, 1);
  assert.equal(idx.get('cse_multi').cwd, 'C:\\start\\cwd');
});

test('dry run uses real local mapping, paginates, never opens/writes', async t => {
  const base = fixture(t), calls = [];
  const fetchImpl = async url => { calls.push(url); return { ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : url.includes('cursor=next') ? { data: [] } : { data: [{ id: 'cse_one', title: 'Work' }], next_cursor: 'next' } }; };
  const result = await reopenLost({ base, since, until, dryRun: true, fetchImpl, spawn: (cmd, args) => {
    assert.deepEqual(args, ['agents', '--json']); return { status: 0, stdout: '[]' };
  } });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.reopened.length, 0);
  assert.equal(calls.length, 3);
  assert.equal(fs.existsSync(path.join(base, 'reopen-lost-sessions.log')), false);
  fs.mkdirSync(path.join(base, 'projects', '_deleted-backup'));
  fs.renameSync(path.join(base, 'projects', 'proj', 'one.jsonl'), path.join(base, 'projects', '_deleted-backup', 'one.jsonl'));
  assert.equal(localIndex(base).size, 0);
});

test('opening continues after API deadline; focus precedes URI; lock released and log written', async t => {
  const base = fixture(t), calls = []; let clock = 0;
  const result = await reopenLost({ base, since, until, codeCli: 'C:\\code.cmd', now: () => clock,
    fetchImpl: async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } }),
    spawn: (cmd, args) => { calls.push(args); return { status: 0, stdout: args[0] === 'agents' ? '[]' : '' }; },
    windowReady: () => { clock = 120000; return true; }, wait: async () => {},
  });
  assert.equal(result.reopened.length, 1);
  const ps = calls.filter(a => a[0] !== 'agents');
  assert.ok(ps[0].at(-1).includes('C:\\work'));
  assert.ok(ps[1].at(-1).includes('--open-url'));
  assert.equal(fs.existsSync(path.join(base, 'reopen-lost-sessions.lock')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(base, 'reopen-lost-sessions.log'))).reopened.length, 1);
});

test('unknown agents prevents API/open; concurrent lock and stale lock', async t => {
  const base = fixture(t);
  const result = await reopenLost({ base, since, until, dryRun: true, spawn: () => ({ status: 1 }), fetchImpl: () => assert.fail() });
  assert.match(result.error, /failed/);
  const file = path.join(base, 'test.lock'), release = acquireLock(file);
  assert.equal(acquireLock(file), null); release();
  fs.writeFileSync(file, 'stale'); fs.utimesSync(file, new Date(0), new Date(0));
  acquireLock(file)();
});

test('API failure is explicit and partial candidates survive API-only deadline', async t => {
  const base = fixture(t); let clock = 0;
  const result = await reopenLost({ base, since, until, dryRun: true, now: () => clock,
    spawn: () => ({ status: 0, stdout: '[]' }), fetchImpl: async url => ({ ok: true, json: async () => {
      if (url.includes('/events?')) { clock = 61000; return { data: [exit] }; }
      assert.equal(new URL(url).searchParams.has('cursor'), false);
      return { data: [{ id: 'cse_one' }], next_cursor: 'later' };
    } }),
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.apiError, 'API time limit');
});

test('closed during fetch is excluded at dispatch time', async t => {
  const base = fixture(t);
  const result = await reopenLost({ base, since, until, codeCli: 'mock',
    spawn: (cmd, args) => { assert.equal(args[0], 'agents'); return { status: 0, stdout: '[]' }; },
    fetchImpl: async url => ({ ok: true, json: async () => {
      if (url.includes('/events?')) { fs.writeFileSync(path.join(base, 'closed-sessions.json'), JSON.stringify({ ids: ['one'] })); return { data: [exit] }; }
      return { data: [{ id: 'cse_one' }] };
    } }),
  });
  assert.equal(result.reopened.length, 0);
  assert.equal(result.skipped.closed, 1);
});

test('watchReopen since/until calculation and watermark behavior', async t => {
  const base = fixture(t);
  const fixedNow = Date.parse('2026-11-07T12:00:00.000Z');
  const now = () => fixedNow;
  const stateFile = path.join(base, 'reopen-lost-sessions-state.json');

  const fetchImplNoOp = async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [] } : { data: [] } });
  const spawnNoOp = () => ({ status: 0, stdout: '[]' });

  // Case A: No state file -> defaultSince = now - 30m, until = now - 60s
  let result = await watchReopen({ base, fetchImpl: fetchImplNoOp, spawn: spawnNoOp, now });
  assert.equal(result.since, '2026-11-07T11:30:00.000Z');
  assert.equal(result.until, '2026-11-07T11:59:00.000Z');
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).watermark, '2026-11-07T11:59:00.000Z');

  // Case B: Watermark exists and is recent -> since = watermark
  fs.writeFileSync(stateFile, JSON.stringify({ watermark: '2026-11-07T10:00:00.000Z' }) + '\n');
  result = await watchReopen({ base, fetchImpl: fetchImplNoOp, spawn: spawnNoOp, now });
  assert.equal(result.since, '2026-11-07T10:00:00.000Z');
  assert.equal(result.until, '2026-11-07T11:59:00.000Z');

  // Case C: Watermark exists but is older than 24h -> truncated to now - 24h
  fs.writeFileSync(stateFile, JSON.stringify({ watermark: '2026-11-05T10:00:00.000Z' }) + '\n');
  result = await watchReopen({ base, fetchImpl: fetchImplNoOp, spawn: spawnNoOp, now });
  assert.equal(result.since, '2026-11-06T12:00:00.000Z');
  assert.equal(result.until, '2026-11-07T11:59:00.000Z');

  // Case D: Dry run -> state watermark not changed
  fs.writeFileSync(stateFile, JSON.stringify({ watermark: '2026-11-07T11:00:00.000Z' }) + '\n');
  result = await watchReopen({ base, dryRun: true, fetchImpl: fetchImplNoOp, spawn: spawnNoOp, now });
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).watermark, '2026-11-07T11:00:00.000Z');

  // Case E: Error / API error -> state watermark not changed
  const fetchImplError = async () => ({ ok: false, status: 500 });
  result = await watchReopen({ base, fetchImpl: fetchImplError, spawn: spawnNoOp, now });
  assert.ok(result.apiError);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).watermark, '2026-11-07T11:00:00.000Z');
});

test('exclusions for archivedByUser and reopenLoop', async t => {
  const base = fixture(t);
  const now = () => Date.parse('2026-11-07T12:00:00.000Z');

  // archivedByUser test: session.status === 'archived' and hostExitArchive is false
  const userArchivedEvent = { event_type: 'user', payload: { request: { subtype: 'end_session', reason: 'archived' } }, created_at: '2026-11-07T11:00:00Z' };
  const fetchImplArchived = async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit, userArchivedEvent] } : { data: [{ id: 'cse_one', status: 'archived' }] } });

  let result = await reopenLost({ base, since, until, dryRun: true, now, fetchImpl: fetchImplArchived, spawn: () => ({ status: 0, stdout: '[]' }) });
  assert.equal(result.skipped.archivedByUser, 1);

  // reopenLoop test: session reopened 3 times in reopen-lost-sessions.log in last 24h
  const logFile = path.join(base, 'reopen-lost-sessions.log');
  const logEntries = [
    { at: '2026-11-07T08:00:00.000Z', reopened: [{ id: 'one' }] },
    { at: '2026-11-07T09:00:00.000Z', reopened: [{ id: 'one' }] },
    { at: '2026-11-07T10:00:00.000Z', reopened: [{ id: 'one' }] },
  ];
  fs.writeFileSync(logFile, logEntries.map(e => JSON.stringify(e)).join('\n') + '\n');

  const fetchImplNormal = async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } });
  result = await reopenLost({ base, since, until, dryRun: true, now, fetchImpl: fetchImplNormal, spawn: () => ({ status: 0, stdout: '[]' }) });
  assert.equal(result.skipped.reopenLoop, 1);
});

test('post-reopen verification records verified and unverified', async t => {
  const base = fixture(t);
  let clock = 0;
  let agentCheckCount = 0;

  const result = await reopenLost({
    base, since, until, codeCli: 'C:\\code.cmd', now: () => clock,
    fetchImpl: async url => ({ ok: true, json: async () => url.includes('/events?') ? { data: [exit] } : { data: [{ id: 'cse_one' }] } }),
    spawn: (cmd, args) => {
      if (args[0] === 'agents') {
        agentCheckCount++;
        if (agentCheckCount > 1) return { status: 0, stdout: '[]' };
        return { status: 0, stdout: '[]' };
      }
      return { status: 0, stdout: '' };
    },
    windowReady: () => true,
    wait: async () => {},
  });

  assert.equal(result.reopened.length, 1);
  assert.deepEqual(result.verified, []);
  assert.deepEqual(result.unverified, ['one']);
});
