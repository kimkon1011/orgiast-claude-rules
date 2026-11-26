import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { main, supervise } from '../tools/deadline-watch.mjs';
import { dataPath, withLedgerLock, DEFAULT_CONFIG } from '../tools/deadline-ledger.mjs';
import { createSheetsClient } from '../tools/lib/sheets-dwd.mjs';

const homeFor = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deadline-prod-test-'));
const never = () => new Promise(() => {});
const config = { ...DEFAULT_CONFIG, sheetId: 'mock', vehicleSheetId: '', calendar: { enabled: false } };
const row = id => ({ id, title: 'test', kind: 'その他', assignee: 'kim', status: '未着手', due: '2026-11-27' });
const readLog = home => fs.readdirSync(dataPath(home, '')).filter(f => f.startsWith('run-')).map(f => fs.readFileSync(dataPath(home, f), 'utf8')).join('\n');
const depsFor = (home, extra) => ({
  home, config, skipSeatCheck: true, stdout: () => {}, stderr: () => {}, heartbeat: async () => {},
  request: async () => assert.fail('unexpected HTTP'), sheets: {}, readInbox: async () => [], ...extra,
});

test('production: Sheets and inbox timeouts continue remaining stages and rows, exit 2', async () => {
  const home = homeFor(), calls = [], notices = [], errors = [];
  const code = await main(['--now', '2026-11-27'], depsFor(home, {
    timeouts: { httpMs: 25, inboxMs: 25, totalMs: 2_000 },
    stderr: message => errors.push(message),
    ledger: { read: async () => [row('D-1'), row('D-2')], patch: async (id, change) => {
      calls.push([id, change]);
      if (id === 'D-1' && 'remainingDays' in change) await never();
    }},
    notify: async ({ row, signal }) => {
      notices.push(row.id);
      if (row.id === 'D-1') await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
    },
  }));
  assert.equal(code, 2);
  assert.deepEqual(notices, ['D-1', 'D-2']);
  assert.ok(calls.some(([id, change]) => id === 'D-2' && 'lastNotified' in change));
  assert.ok(!calls.some(([id, change]) => id === 'D-1' && 'lastNotified' in change));
  assert.ok(errors.some(line => line.includes('D-1 Sheets remainingDays')));
  const log = readLog(home);
  assert.match(log, /START D-1 Sheets remainingDays/);
  assert.match(log, /WARN .*timeout/);
  assert.match(log, /END D-1 kim-inbox add/);
  assert.match(log, /START D-2 Calendar sync/);
});

test('overall watchdog stops hanging operation before next row, exits 2', async () => {
  const home = homeFor(), notices = [];
  const code = await main(['--now', '2026-11-27'], depsFor(home, {
    timeouts: { totalMs: 75, httpMs: 5_000, inboxMs: 5_000 },
    ledger: { read: async () => [row('D-1'), row('D-2')], patch: async () => {} },
    notify: async ({ row }) => { notices.push(row.id); return never(); },
  }));
  assert.equal(code, 2);
  assert.deepEqual(notices, ['D-1']);
  assert.match(readLog(home), /overall watchdog/);
  assert.match(fs.readFileSync(dataPath(home, '.lock'), 'utf8'), /^0 /);
});

test('wall-clock supervisor kills worker and reports partial success', async () => {
  const home = homeFor(), child = new EventEmitter();
  let killed;
  child.kill = signal => { killed = signal; child.emit('exit', null, signal); return true; };
  // The exit event can arrive synchronously in a mock (real workers emit later).
  const code = await supervise([], { home, timeoutMs: 20, spawnImpl: () => child, stderr: () => {} });
  assert.equal(killed, 'SIGKILL');
  assert.equal(code, 2);
  assert.match(readLog(home), /overall watchdog/);
});

test('stale PID is taken over in-place and live lock wait ends without stealing', async () => {
  const home = homeFor(), file = dataPath(home, '.lock');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid;
  fs.writeFileSync(file, String(dead));
  const inode = fs.statSync(file).ino;
  await withLedgerLock(home, async () => {
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp('^' + process.pid + ' '));
    await assert.rejects(withLedgerLock(home, async () => assert.fail('stolen'), { waitMs: 20, pollMs: 5 }), /lock timeout/);
  });
  assert.equal(fs.statSync(file).ino, inode);
  assert.match(fs.readFileSync(file, 'utf8'), /^0 /);
  await withLedgerLock(home, async () => assert.match(fs.readFileSync(file, 'utf8'), new RegExp('^' + process.pid + ' ')));
});

test('Sheets total budget includes response body and prevents retry after timeout', async () => {
  let attempts = 0;
  const client = createSheetsClient({
    totalTimeoutMs: 25, timeoutMs: 5_000, getToken: async () => 'mock',
    fetchImpl: async () => { attempts++; return { ok: false, status: 429, headers: { get: () => '1' } }; },
    sleep: never,
  });
  // AbortSignal.timeout is unref'ed, so keep the test event loop alive.
  const keepAlive = setInterval(() => {}, 100);
  try {
    await assert.rejects(client.get('mock', 'A1'), /timeout/i);
    assert.equal(attempts, 1);
    const body = createSheetsClient({ totalTimeoutMs: 25, getToken: async () => 'mock', fetchImpl: async () => ({ ok: true, json: never }) });
    await assert.rejects(body.get('mock', 'A1'), /timeout/i);
  } finally { clearInterval(keepAlive); }
});
