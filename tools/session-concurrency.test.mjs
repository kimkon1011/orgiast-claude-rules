import assert from 'node:assert/strict';
import test from 'node:test';
import { checkSessionConcurrency, countOpenSessions } from './lib/session-concurrency.mjs';

const rows = count => Array.from({ length: count }, (_, index) => ({
  Name: 'claude.exe', ProcessId: index + 100, ParentProcessId: 50,
  CommandLine: '"C:\\cli\\claude.exe" --resume=id',
}));

test('Windows accepts 19 sessions and blocks at or above 20', () => {
  for (const count of [19, 20, 21]) {
    assert.deepEqual(checkSessionConcurrency({ platform: 'win32', env: {}, list: () => rows(count) }), {
      ok: count < 20, reason: count < 20 ? 'available' : 'session_concurrency_cap', count, limit: 20,
    });
  }
});

test('override, enumeration failure and non-Windows behavior', () => {
  const env = { CLAUDE_MAX_CONCURRENT_SESSIONS: '2' };
  assert.equal(checkSessionConcurrency({ platform: 'win32', env, list: () => rows(2) }).ok, false);
  assert.deepEqual(checkSessionConcurrency({ platform: 'win32', env, list() { throw Error('CIM'); } }), {
    ok: true, reason: 'process_enumeration_failed', count: null, limit: 2,
  });
  assert.deepEqual(checkSessionConcurrency({ platform: 'linux', env, list() { assert.fail('CIM'); } }), {
    ok: true, reason: 'unsupported_platform', count: null, limit: 2,
  });
});

test('counts resumed tabs and IDE/SDK roots, excluding Desktop, children and print mode', () => {
  assert.equal(countOpenSessions([
    ...rows(1),
    { Name: 'claude.exe', ProcessId: 200, ParentProcessId: 50, CommandLine: 'claude.exe --input-format stream-json' },
    { Name: 'claude.exe', ProcessId: 201, ParentProcessId: 50, CommandLine: 'claude.exe --output-format stream-json' },
    { ...rows(1)[0], ProcessId: 202, ParentProcessId: 100 },
    { ...rows(1)[0], ProcessId: 203, ExecutablePath: 'C:\\Program Files\\WindowsApps\\Claude_1\\claude.exe' },
    { ...rows(1)[0], ProcessId: 204, CommandLine: 'claude.exe --print --resume abc --output-format stream-json' },
    { ...rows(1)[0], ProcessId: 205, CommandLine: 'claude.exe --type=renderer --resume abc' },
    { ...rows(1)[0], ProcessId: 206, CommandLine: 'claude.exe' },
  ]), 3);
});

test('async enumeration uses the same limit and fails open on rejection', async () => {
  const { checkSessionConcurrencyAsync } = await import('./lib/session-concurrency.mjs');
  const options = { platform: 'win32', env: {} };
  assert.equal((await checkSessionConcurrencyAsync({ ...options, list: async () => rows(20) })).ok, false);
  assert.equal((await checkSessionConcurrencyAsync({ ...options, list: async () => { throw Error('CIM'); } })).reason,
    'process_enumeration_failed');
});
