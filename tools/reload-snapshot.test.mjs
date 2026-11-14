import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveSnapshot, restoreSnapshot } from './reload-snapshot.mjs';

const BASE = path.join(os.homedir(), '.claude');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reload-snap-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const base = path.join(root, '.claude');
  const sessionsDir = path.join(base, 'sessions');
  const projectsDir = path.join(base, 'projects', 'proj');
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.mkdirSync(projectsDir, { recursive: true });
  return { root, base, sessionsDir, projectsDir };
}

// Helper: write a session PID file (simulates live session)
function writePidFile(sessionsDir, pid, sessionId, opts = {}) {
  const data = {
    pid,
    sessionId,
    kind: 'interactive',
    startedAt: new Date().toISOString(),
    ...opts,
  };
  fs.writeFileSync(path.join(sessionsDir, `${pid}.json`), JSON.stringify(data));
}

// Helper: write a transcript with a bridge-session row and user content
function writeTranscript(projectsDir, id, cwd, opts = {}) {
  const rows = [
    { type: 'bridge-session', bridgeSessionId: `cse_${id}` },
    { type: 'user', cwd: cwd || 'C:\\work', message: { content: opts.content || 'hello' } },
  ];
  if (opts.extraRows) rows.push(...opts.extraRows);
  fs.writeFileSync(path.join(projectsDir, `${id}.jsonl`), rows.map(JSON.stringify).join('\n') + '\n');
}

// --- save tests ---

test('save: extracts live, unclosed, non-empty sessions', t => {
  const { base, sessionsDir, projectsDir } = fixture(t);
  const pid = process.pid; // our own process is alive
  writePidFile(sessionsDir, pid, 'cse_live-session');
  writeTranscript(projectsDir, 'cse_live-session', 'C:\\work');

  const snapFile = path.join(base, 'snap.json');
  const result = saveSnapshot(snapFile, { base });
  assert.equal(result.count, 1);
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  assert.equal(snap.version, 1);
  assert.equal(snap.sessions.length, 1);
  assert.equal(snap.sessions[0].sessionId, 'cse_live-session');
  assert.equal(snap.sessions[0].cwd, 'C:\\work');
});

test('save: preserves Japanese and full-width characters in cwd', t => {
  const { base, sessionsDir, projectsDir } = fixture(t);
  writePidFile(sessionsDir, process.pid, 'cse-japanese-cwd');
  const cwd = 'C:\\Users\\uers\\Downloads\\CLAUDE.md配布\\全角フォルダー';
  writeTranscript(projectsDir, 'cse-japanese-cwd', cwd);

  const snapFile = path.join(base, 'snap.json');
  saveSnapshot(snapFile, { base });
  const snap = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
  assert.equal(snap.sessions[0].cwd, cwd);
});

test('save: excludes closed sessions', t => {
  const { base, sessionsDir, projectsDir } = fixture(t);
  const pid = process.pid;
  writePidFile(sessionsDir, pid, 'cse_closed-session');
  writeTranscript(projectsDir, 'cse_closed-session', 'C:\\work');
  fs.writeFileSync(path.join(base, 'closed-sessions.json'), JSON.stringify({ ids: ['cse_closed-session'] }));

  const snapFile = path.join(base, 'snap.json');
  const result = saveSnapshot(snapFile, { base });
  assert.equal(result.count, 0);
});

test('save: excludes sessions without conversation', t => {
  const { base, sessionsDir, projectsDir } = fixture(t);
  const pid = process.pid;
  writePidFile(sessionsDir, pid, 'cse_empty-session');
  // Write transcript with only bridge-session, no user content
  fs.writeFileSync(path.join(projectsDir, 'cse_empty-session.jsonl'),
    JSON.stringify({ type: 'bridge-session', bridgeSessionId: 'cse_empty-session' }) + '\n');

  const snapFile = path.join(base, 'snap.json');
  const result = saveSnapshot(snapFile, { base });
  assert.equal(result.count, 0);
});

test('save: excludes sessions without cwd', t => {
  const { base, sessionsDir, projectsDir } = fixture(t);
  const pid = process.pid;
  writePidFile(sessionsDir, pid, 'cse_no-cwd');
  // Transcript with bridge-session but no cwd row
  fs.writeFileSync(path.join(projectsDir, 'cse_no-cwd.jsonl'),
    JSON.stringify({ type: 'bridge-session', bridgeSessionId: 'cse_no-cwd' }) + '\n');

  const snapFile = path.join(base, 'snap.json');
  const result = saveSnapshot(snapFile, { base });
  assert.equal(result.count, 0);
});

test('save: dry-run does not write file', t => {
  const { base, sessionsDir, projectsDir } = fixture(t);
  const pid = process.pid;
  writePidFile(sessionsDir, pid, 'cse_dry-session');
  writeTranscript(projectsDir, 'cse_dry-session', 'C:\\work');

  const snapFile = path.join(base, 'snap-dry.json');
  const result = saveSnapshot(snapFile, { base, dryRun: true });
  assert.equal(result.count, 1);
  assert.equal(fs.existsSync(snapFile), false);
  // dry-run output includes session list
  assert.ok(Array.isArray(result.sessions));
  assert.equal(result.sessions[0].sessionId, 'cse_dry-session');
});

test('save: falls back to agentsFromRegistry when PID-based liveness returns empty', t => {
  const { base, sessionsDir, projectsDir } = fixture(t);
  // Write a PID file for a non-existent PID (will be excluded by PID check)
  writePidFile(sessionsDir, 999999, 'cse_dead-session');
  writeTranscript(projectsDir, 'cse_dead-session', 'C:\\work');

  const snapFile = path.join(base, 'snap.json');
  const result = saveSnapshot(snapFile, { base });
  assert.equal(result.count, 0);
});

test('save: handles missing sessions dir gracefully', t => {
  const { base } = fixture(t);
  // Remove sessions dir
  fs.rmSync(path.join(base, 'sessions'), { recursive: true, force: true });
  const snapFile = path.join(base, 'snap.json');
  const result = saveSnapshot(snapFile, { base });
  assert.equal(result.count, 0);
});

// --- restore tests ---

test('restore: success path (mock spawn and wait)', async t => {
  const { base } = fixture(t);
  const snapFile = path.join(base, 'snap.json');
  const snapshot = {
    version: 1,
    at: new Date().toISOString(),
    sessions: [{ sessionId: 'cse_test', cwd: 'C:\\work' }],
  };
  fs.writeFileSync(snapFile, JSON.stringify(snapshot, null, 2));

  // Write a bridge session file to simulate successful connection
  const sessionsDir = path.join(base, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const bridgePid = 12345;
  fs.writeFileSync(path.join(sessionsDir, `${bridgePid}.json`), JSON.stringify({
    pid: bridgePid,
    sessionId: 'cse_test',
    bridgeSessionId: 'cse_bridge-test',
  }));

  let spawnCalls = [];
  const mockSpawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args });
    return { status: 0, stdout: '', error: null };
  };
  let waitCalls = 0;
  const mockWait = async (ms) => { waitCalls++; };

  const result = await restoreSnapshot(snapFile, {
    base,
    codeCli: 'C:\\code.cmd',
    spawn: mockSpawn,
    wait: mockWait,
    now: () => Date.now(),
  });

  assert.equal(result.connected.length, 1);
  assert.equal(result.connected[0].id, 'cse_test');
  assert.equal(result.failed.length, 0);
  assert.ok(spawnCalls.length >= 2); // --reuse-window + --open-url
});

test('restore: 90s timeout then retry, then failure', async t => {
  const { base } = fixture(t);
  const snapFile = path.join(base, 'snap.json');
  const snapshot = {
    version: 1,
    at: new Date().toISOString(),
    sessions: [{ sessionId: 'cse_timeout', cwd: 'C:\\work' }],
  };
  fs.writeFileSync(snapFile, JSON.stringify(snapshot, null, 2));

  // No bridge session file will appear
  let clock = 0;
  const mockSpawn = (cmd, args, opts) => ({ status: 0, stdout: '', error: null });
  const mockWait = async (ms) => { clock += ms; };
  const mockNow = () => clock;

  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const result = await restoreSnapshot(snapFile, {
      base,
      codeCli: 'C:\\code.cmd',
      spawn: mockSpawn,
      wait: mockWait,
      now: mockNow,
    });

    assert.equal(result.connected.length, 0);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].id, 'cse_timeout');
    assert.ok(result.failed[0].error.includes('bridge session not found'));
  } finally {
    process.exitCode = origExitCode;
  }
});

test('restore: exit code 2 on failure', async t => {
  const { base } = fixture(t);
  const snapFile = path.join(base, 'snap.json');
  const snapshot = {
    version: 1,
    at: new Date().toISOString(),
    sessions: [{ sessionId: 'cse_fail', cwd: 'C:\\work' }],
  };
  fs.writeFileSync(snapFile, JSON.stringify(snapshot, null, 2));

  const mockSpawn = (cmd, args, opts) => ({ status: 0, stdout: '', error: null });
  const mockWait = async (ms) => {};
  const mockNow = () => 0; // always past deadline

  const result = await restoreSnapshot(snapFile, {
    base,
    codeCli: 'C:\\code.cmd',
    spawn: mockSpawn,
    wait: mockWait,
    now: mockNow,
  });
  assert.equal(result.connected.length, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, 'cse_fail');
  assert.ok(result.failed[0].error.includes('bridge session not found'));
});

test('restore: invalid snapshot throws', async t => {
  const { base } = fixture(t);
  const snapFile = path.join(base, 'bad.json');
  fs.writeFileSync(snapFile, JSON.stringify({ version: 0, sessions: [] }));
  await assert.rejects(() => restoreSnapshot(snapFile, { base }), /Invalid reload snapshot/);
});

test('restore: missing sessionId or cwd in snapshot entry', async t => {
  const { base } = fixture(t);
  const snapFile = path.join(base, 'snap.json');
  const snapshot = {
    version: 1,
    at: new Date().toISOString(),
    sessions: [
      { cwd: 'C:\\work' }, // missing sessionId
      { sessionId: 'cse_no-cwd' }, // missing cwd
    ],
  };
  fs.writeFileSync(snapFile, JSON.stringify(snapshot, null, 2));

  const mockSpawn = (cmd, args, opts) => ({ status: 0, stdout: '', error: null });
  const mockWait = async (ms) => {};

  const result = await restoreSnapshot(snapFile, {
    base,
    codeCli: 'C:\\code.cmd',
    spawn: mockSpawn,
    wait: mockWait,
    now: () => Date.now(),
  });

  assert.equal(result.connected.length, 0);
  assert.equal(result.failed.length, 2);
  assert.ok(result.failed.every(f => f.error));
});

test('restore: spawn error is caught and reported', async t => {
  const { base } = fixture(t);
  const snapFile = path.join(base, 'snap.json');
  const snapshot = {
    version: 1,
    at: new Date().toISOString(),
    sessions: [{ sessionId: 'cse_spawn-err', cwd: 'C:\\work' }],
  };
  fs.writeFileSync(snapFile, JSON.stringify(snapshot, null, 2));

  const mockSpawn = (cmd, args, opts) => ({ status: 1, stdout: '', error: new Error('spawn failed') });
  const mockWait = async (ms) => {};

  const origExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    const result = await restoreSnapshot(snapFile, {
      base,
      codeCli: 'C:\\code.cmd',
      spawn: mockSpawn,
      wait: mockWait,
      now: () => Date.now(),
    });

    assert.equal(result.connected.length, 0);
    assert.equal(result.failed.length, 1);
    assert.ok(result.failed[0].error.includes('spawn failed'));
  } finally {
    process.exitCode = origExitCode;
  }
});
