import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAbandoned, decideLaunch, evaluateSessionCap, HOURLY_MARKER } from './session-cap-guard.mjs';

const hourly = (pid) => ({ Name: 'claude.exe', ProcessId: pid, CommandLine: `claude -p "${HOURLY_MARKER}"` });

test('below the cap allows launch and ignores unrelated Claude processes', () => {
  const result = evaluateSessionCap([hourly(1), { Name: 'claude.exe', CommandLine: 'claude --interactive' }], { limit: 2 });
  assert.equal(result.allow, true);
  assert.equal(result.active.length, 1);
});

test('at the cap skips launch', () => {
  const result = evaluateSessionCap([hourly(1), hourly(2)], { limit: 2 });
  assert.equal(result.allow, false);
});

test('abandoned boundary is inclusive and closed sessions are excluded', () => {
  const now = Date.parse('2026-11-17T12:00:00.000Z');
  const sessions = [
    { sessionId: 'before', lastActivity: '2026-11-17T09:00:00.001Z', closed: false },
    { sessionId: 'boundary', lastActivity: '2026-11-17T09:00:00.000Z', closed: false },
    { sessionId: 'closed', lastActivity: '2026-11-17T08:00:00.000Z', closed: true },
  ];
  assert.deepEqual(classifyAbandoned(sessions, now, 3).map((row) => row.sessionId), ['boundary']);
});

test('enumeration failure warns and fails open', () => {
  const result = decideLaunch({ enumerateProcesses: () => { throw new Error('CIM unavailable'); }, listSessions: () => [] });
  assert.equal(result.allow, true);
  assert.match(result.warning, /CIM unavailable/);
});

test('non-hourly Claude launch bypasses the hourly cap', () => {
  const result = decideLaunch({
    isHourlyLaunch: () => false,
    enumerateProcesses: () => [hourly(1), hourly(2)],
    listSessions: () => { throw new Error('must not scan'); },
  });
  assert.equal(result.allow, true);
  assert.equal(result.applicable, false);
});
