import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runOnce, invokeClaude, buildPrompt } from './autopilot-run.mjs';
import { runAutopilot, acquireLock } from './autopilot-tick.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autopilot-run-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, dir: path.join(home, 'state'), token: '', userId: '', now: new Date('2026-09-21T01:00:00Z'), fetchImpl: async () => { throw new Error('unexpected network'); } };
}

test('runner does not invoke Claude when unstarted, paused, stopped, or done', async (t) => {
  const opts = fixture(t);
  opts.invokeImpl = async () => { assert.fail('must not invoke Claude'); };
  assert.equal((await runOnce(opts)).skipped, 'not_started');
  await runAutopilot('start', { objective: 'test' }, opts);
  await runAutopilot('pause', {}, opts);
  assert.equal((await runOnce(opts)).skipped, 'manual_pause');
  await runAutopilot('stop', {}, opts);
  assert.equal((await runOnce(opts)).skipped, 'manual_stop');
  await runAutopilot('resume', {}, opts);
  await runAutopilot('post', { summary: 'complete', progress: 100 }, opts);
  assert.equal((await runOnce(opts)).skipped, 'done');
});

test('models follow planIncluded; prompt comes from skill and headless uses one foreground iteration', async (t) => {
  for (const [policy, model] of [[{ planIncluded: true }, 'claude-fable-5-1'], [{ planIncluded: false }, 'claude-opus-5'], [{}, 'claude-opus-5']]) {
    const opts = fixture(t);
    await runAutopilot('start', { objective: 'test' }, opts);
    const result = await runOnce({ ...opts, policy, executable: 'fake-claude', invokeImpl: async (invocation) => {
      assert.deepEqual(invocation.args, ['-p', '--model', model, '--output-format', 'text']);
      assert.match(invocation.prompt, /codex-do\.mjs/);
      assert.match(invocation.prompt, /ScheduleWakeup と \/loop は使用しない/);
      assert.equal(invocation.timeoutMs, 25 * 60_000);
      await runAutopilot('post', { summary: 'work verified', progress: 10, codex: true }, opts);
      return { exitCode: 0, stdout: 'tail test' };
    } });
    assert.equal(result.model, model);
    assert.equal((await runAutopilot('status', {}, opts)).state.totalIterations, 1);
    const log = fs.readFileSync(path.join(opts.dir, 'run.log'), 'utf8');
    assert.match(log, /tail test/);
    assert.match(log, /"exitCode":0/);
  }
});

test('repeated missing posts and timeouts are counted and trip the noop watchdog', async (t) => {
  const opts = fixture(t);
  await runAutopilot('start', { objective: 'test', 'max-noop': 2 }, opts);
  const invokeImpl = async () => ({ exitCode: 1, timedOut: true, stdout: '' });
  assert.equal((await runOnce({ ...opts, invokeImpl })).status, 'running');
  assert.equal((await runOnce({ ...opts, invokeImpl })).status, 'paused');
  const state = (await runAutopilot('status', {}, opts)).state;
  assert.equal(state.totalIterations, 2);
  assert.equal(state.pausedReason, 'noop_streak');
  assert.ok(fs.existsSync(path.join(opts.home, '.claude', 'next-session.md')));
});

test('runner lock prevents overlapping headless invocations', async (t) => {
  const opts = fixture(t);
  fs.mkdirSync(opts.dir, { recursive: true });
  const release = acquireLock(path.join(opts.dir, 'run.lock'));
  try { assert.equal((await runOnce(opts)).skipped, 'already_running'); }
  finally { release(); }
});

test('prompt reads changed skill at runtime rather than a duplicated instruction block', (t) => {
  const opts = fixture(t);
  fs.mkdirSync(path.join(opts.home, 'skills', 'autopilot'), { recursive: true });
  fs.writeFileSync(path.join(opts.home, 'skills', 'autopilot', 'SKILL.md'), '---\nname: autopilot\n---\nUNIQUE SKILL BODY');
  assert.match(buildPrompt(opts.home), /UNIQUE SKILL BODY/);
});

test('real child process gets prompt via stdin; exit code and output are captured', async (t) => {
  const opts = fixture(t);
  const result = await invokeClaude({ executable: process.execPath, args: ['-e', "process.stdin.on('data', b => process.stdout.write(b)); process.stdin.on('end', () => process.exit(7));"], prompt: '日本語 " $ test', cwd: opts.home, timeoutMs: 5000 });
  assert.equal(result.exitCode, 7);
  assert.equal(result.stdout, '日本語 " $ test');
  assert.equal(result.timedOut, false);
});

test('real child timeout is bounded and missing executable returns failure', async (t) => {
  const opts = fixture(t);
  const timed = await invokeClaude({ executable: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], prompt: '', cwd: opts.home, timeoutMs: 100 });
  assert.equal(timed.timedOut, true);
  assert.notEqual(timed.exitCode, 0);
  const missing = await invokeClaude({ executable: path.join(opts.home, 'not-a-real-executable'), args: [], prompt: '', cwd: opts.home, timeoutMs: 1000 });
  assert.equal(missing.launchError, 'ENOENT');
});
