import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runStaleTaskHealth } from './stale-task-health.mjs';

test('daily repair is applied once, retains notification, and runs again next day', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-health-'));
  let calls = 0;
  const spawn = (_exe, args) => {
    calls++;
    assert.ok(args.includes('-Apply'));
    fs.writeFileSync(args.at(-1), JSON.stringify([{ TaskName: 'OrgiastFixture', Index: 0, Status: 'repaired', OldArguments: 'old', NewArguments: 'new' }]));
    return { status: 0, stdout: 'summary' };
  };
  try {
    const opts = { home, platform: 'win32', spawn, now: new Date(2026, 9, 29) };
    assert.deepEqual(await runStaleTaskHealth({ ...opts, dryRun: true }), { anomalies: [] });
    assert.equal(calls, 0);
    const first = await runStaleTaskHealth(opts);
    assert.match(first.anomalies[0].message, /検出 1 \/ 修復 1/);
    assert.deepEqual(await runStaleTaskHealth(opts), first);
    assert.equal(calls, 1);
    await runStaleTaskHealth({ ...opts, now: new Date(2026, 9, 30) });
    assert.equal(calls, 2);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('failed execution is reported and suppressed for the day', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stale-health-'));
  let calls = 0;
  try {
    const opts = { home, platform: 'win32', spawn: () => { calls++; throw new Error('fixture failure'); } };
    const result = await runStaleTaskHealth(opts);
    assert.match(result.anomalies[0].message, /fixture failure/);
    await runStaleTaskHealth(opts);
    assert.equal(calls, 1);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
