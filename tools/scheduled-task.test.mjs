import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerHourlyTask } from './lib/scheduled-task.mjs';

test('registerHourlyTask throws on ephemeral home and never spawns', () => {
  let calls = 0;
  const spawnImpl = () => { calls += 1; return { status: 0, stdout: '', stderr: '' }; };
  const home = path.join(os.tmpdir(), 'codex-do-cursor-agent-home');
  assert.throws(
    () => registerHourlyTask('OrgiastProcessHygiene', 'C:\\Users\\kimko\\.claude\\nightly-repo\\tools\\process-hygiene.mjs', {
      home,
      spawnImpl,
    }),
    /unstable task path/,
  );
  assert.equal(calls, 0);
});

test('registerHourlyTask throws on ephemeral home even when dryRun is true', () => {
  let calls = 0;
  const spawnImpl = () => { calls += 1; return { status: 0, stdout: '', stderr: '' }; };
  assert.throws(
    () => registerHourlyTask('OrgiastProcessHygiene', 'C:\\Users\\kimko\\.claude\\nightly-repo\\tools\\process-hygiene.mjs', {
      home: 'C:\\Users\\kimko\\AppData\\Local\\Temp\\codex-do-cursor-agent-home',
      dryRun: true,
      spawnImpl,
    }),
    /unstable task path \(run-hidden\)/,
  );
  assert.equal(calls, 0);
});
