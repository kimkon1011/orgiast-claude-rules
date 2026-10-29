import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, sweepFailureStop, enforceFailureStops } from './quota-sweep.mjs';
import { collectCodexUsage, codexSessionDirs } from './usage-stats.mjs';
import { refreshCostDirective } from './cost-improve-loop.mjs';

const failed = (provider, i, outcome = 'failed') => ({ provider, ts: new Date(1000 + i).toISOString(), stopOutcome: outcome, reason: `cause-${i}` });
function home(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-repair-'));
  fs.mkdirSync(path.join(dir, '.claude'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test('failure stop spans windows and changing causes; deferral is not recovery', () => {
  const rows = [failed('claude', 1), failed('codex', 2), failed('claude', 3, 'deferred'), failed('claude', 4, 'exhausted'), failed('claude', 5, 'deadline')];
  assert.equal(sweepFailureStop(rows, 'claude').failures, 3);
  assert.equal(sweepFailureStop(rows, 'codex'), null);
  assert.equal(sweepFailureStop([...rows, failed('claude', 6, 'final')], 'claude'), null);
  assert.equal(sweepFailureStop(rows, 'claude', { since: 1004 }), null);
});
test('existing ledger stops before window API/model launch and notifies once across invocations', async t => {
  const dir = home(t);
  fs.writeFileSync(path.join(dir, '.claude', 'quota-sweep.jsonl'), [1, 2, 3].map(i => JSON.stringify(failed('claude', i))).join('\n'));
  let notifications = 0;
  const io = { platform: 'win32', notify: async () => { notifications++; throw new Error('offline'); }, readWindows: () => { throw new Error('must not query'); }, print: () => {} };
  for (let i = 0; i < 2; i++) {
    const result = await main(['--home', dir, '--provider', 'claude'], io);
    assert.equal(result.skipped, true);
  }
  assert.equal(notifications, 1);
  const state = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'quota-sweep-state.json')));
  assert.equal(state.failureStops.claude.notificationError, 'offline');
  const result = await main(['--home', dir, '--resume', 'claude'], io);
  assert.equal(result.resumed, 'claude');
  const resumed = JSON.parse(fs.readFileSync(path.join(dir, '.claude', 'quota-sweep-state.json')));
  assert.deepEqual(await enforceFailureStops({ home: dir, state: resumed, providers: ['claude'], save() {} }), ['claude']);
});
test('CODEX_HOME sessions supply cumulative usage and patch lines when reporting home differs', t => {
  const dir = home(t), codexHome = path.join(dir, 'wsl-root-codex');
  fs.mkdirSync(path.join(codexHome, 'sessions'), { recursive: true });
  const old = process.env.CODEX_HOME, oldDirs = process.env.CODEX_SESSIONS_DIRS;
  process.env.CODEX_HOME = codexHome; delete process.env.CODEX_SESSIONS_DIRS;
  t.after(() => { if (old === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = old; if (oldDirs === undefined) delete process.env.CODEX_SESSIONS_DIRS; else process.env.CODEX_SESSIONS_DIRS = oldDirs; });
  const rows = [
    { timestamp: new Date().toISOString(), payload: { info: { total_token_usage: { output_tokens: 12 } } } },
    { name: 'apply_patch', input: '*** Begin Patch\n*** Update File: a\n-old\n+new\n+extra\n*** End Patch' },
    { timestamp: new Date().toISOString(), payload: { info: { total_token_usage: { output_tokens: 19 } } } },
  ];
  fs.writeFileSync(path.join(codexHome, 'sessions', 'run.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
  assert.deepEqual(codexSessionDirs(dir), [path.join(codexHome, 'sessions')]);
  const usage = collectCodexUsage({ home: dir, includePatchLines: true });
  assert.equal(usage.sessions, 1); assert.equal(usage.outputTokens, 19);
  assert.equal(usage.added, 2); assert.equal(usage.deleted, 1);
  // Explicit session directories take precedence over CODEX_HOME, even if empty.
  process.env.CODEX_SESSIONS_DIRS = [path.join(dir, 'first'), path.join(dir, 'second')].join(path.delimiter);
  assert.deepEqual(codexSessionDirs(dir), [path.join(dir, 'first'), path.join(dir, 'second')]);
  process.env.CODEX_SESSIONS_DIRS = '';
  assert.deepEqual(codexSessionDirs(dir), []);
  delete process.env.CODEX_SESSIONS_DIRS;
});
test('daily refresh propagates failure and uses selected home before reporting success', () => {
  assert.throws(() => refreshCostDirective({ home: '/tmp/example', spawn: () => ({ status: 1, stderr: 'disk full' }) }), /exit 1.*disk full/);
  assert.match(refreshCostDirective({ home: '/tmp/example', spawn: (_exe, args, options) => {
    assert.match(args[0], /cost-work-loop.mjs$/); assert.equal(options.env.ORGIAST_HOME, '/tmp/example');
    assert.equal(options.timeout, 300000); return { status: 0 };
  } }), /exit 0/);
});
