import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pidAlive, pidIsSessionProcess, parseSessionMeta, liveSessions, START_TIME_TOLERANCE_MS } from './process-hygiene.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'process-hyg-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sessions = path.join(root, '.claude', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  return { root, sessions };
}

test('pidAlive detects our own process as alive', () => {
  assert.equal(pidAlive(process.pid), true);
});

test('pidAlive returns false for an impossible PID', () => {
  assert.equal(pidAlive(999999999), false);
});

test('pidIsSessionProcess: own PID with matching startedAt is alive', () => {
  const startedAt = new Date(Date.now() - 1000).toISOString();
  // We can't call psCreateDate for our own process in tests reliably,
  // so test with no spawn function (returns true from trust kill(0) path).
  assert.equal(pidIsSessionProcess(process.pid, startedAt, { spawn: () => new Date() }), true);
});

test('pidIsSessionProcess: own PID with non-matching startedAt is rejected', () => {
  const startedAt = new Date(Date.now() - START_TIME_TOLERANCE_MS * 2).toISOString();
  // If spawn returns the current time, the recorded time is way off -> false
  assert.equal(pidIsSessionProcess(process.pid, startedAt, { spawn: () => new Date() }), false);
});

test('pidIsSessionProcess: null spawn returns true (cannot verify, trust kill(0))', () => {
  // When spawn is a function that returns null, we trust kill(0)
  assert.equal(pidIsSessionProcess(process.pid, '2020-01-01T00:00:00.000Z', { spawn: () => null }), true);
});

test('parseSessionMeta: valid metadata file returns entry', t => {
  const { sessions } = fixture(t);
  const pid = process.pid;
  fs.writeFileSync(path.join(sessions, `${pid}.json`), JSON.stringify({
    pid,
    sessionId: 'cse_test-session',
    bridgeSessionId: 'cse_bridge-123',
    startedAt: new Date().toISOString(),
    cwd: 'C:\\work',
  }));
  const meta = parseSessionMeta(sessions, pid);
  assert.ok(meta);
  assert.equal(meta.pid, pid);
  assert.equal(meta.sessionId, 'cse_test-session');
  assert.equal(meta.bridgeSessionId, 'cse_bridge-123');
  assert.equal(meta.cwd, 'C:\\work');
});

test('parseSessionMeta: invalid JSON returns null', t => {
  const { sessions } = fixture(t);
  fs.writeFileSync(path.join(sessions, '12345.json'), 'not json{}');
  assert.equal(parseSessionMeta(sessions, 12345), null);
});

test('parseSessionMeta: missing required fields returns null', t => {
  const { sessions } = fixture(t);
  fs.writeFileSync(path.join(sessions, '12345.json'), JSON.stringify({ pid: 12345 }));
  assert.equal(parseSessionMeta(sessions, 12345), null);
});

test('parseSessionMeta: nonexistent file returns null', t => {
  const { sessions } = fixture(t);
  assert.equal(parseSessionMeta(sessions, 99999), null);
});

test('liveSessions: returns Map of live sessions', t => {
  const { sessions } = fixture(t);
  const pid = 99998; // non-existent PID — use a known-dead PID
  fs.writeFileSync(path.join(sessions, `${pid}.json`), JSON.stringify({
    pid,
    sessionId: 'cse_dead-session',
    startedAt: '2020-01-01T00:00:00.000Z',
    cwd: 'C:\\dead',
  }));
  const result = liveSessions(path.dirname(sessions));
  assert.equal(result.size, 0); // dead PID excluded
});

test('liveSessions: empty dir returns empty Map', t => {
  const { sessions } = fixture(t);
  const result = liveSessions(path.dirname(sessions));
  assert.equal(result.size, 0);
});

test('liveSessions: nonexistent base returns empty Map', () => {
  const result = liveSessions('C:\\nonexistent-claude-dir');
  assert.equal(result.size, 0);
});

test('liveSessions: duplicate sessionId keeps first entry', t => {
  const { sessions } = fixture(t);
  const pid1 = process.pid, pid2 = 99002;
  const now = new Date().toISOString();
  fs.writeFileSync(path.join(sessions, `${pid1}.json`), JSON.stringify({
    pid: pid1, sessionId: 'cse_duplicate', bridgeSessionId: 'first', startedAt: now, cwd: 'C:\\first',
  }));
  fs.writeFileSync(path.join(sessions, `${pid2}.json`), JSON.stringify({
    pid: pid2, sessionId: 'cse_duplicate', bridgeSessionId: 'second', startedAt: now, cwd: 'C:\\second',
  }));
  const result = liveSessions(path.dirname(sessions));
  assert.equal(result.size, 1);
  assert.equal(result.get('cse_duplicate').bridgeSessionId, 'first');
});

test('START_TIME_TOLERANCE_MS is 120 seconds', () => {
  assert.equal(START_TIME_TOLERANCE_MS, 120_000);
});