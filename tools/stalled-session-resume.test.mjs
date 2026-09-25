import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run, options, execute, main } from './stalled-session-resume.mjs';
import { buildClaudeHeadlessArgs } from './auto-session-executor.mjs';

async function fixture(t, count = 5) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'stalled-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let time = new Date('2026-09-24T03:00:00Z').getTime();
  let calls = 0, notices = 0;
  const records = Array.from({ length: count }, (_, i) => ({ sessionId: `session-${i}`, displayTitle: `Task ${i}`, file: `file-${i}`, cwd: home, status: '要対応', score: 100 - i, ageDays: 1 }));
  const io = { home, now: () => time, detect: async () => records, stat: async () => ({ mtimeMs: time - 86400000 }),
    execute: async () => { calls++; return { outcome: 'no-progress' }; }, notify: async () => { notices++; return { delivered: 'dm' }; } };
  const file = path.join(home, '.claude/stalled-session-resume.json');
  return { io, file, records, next: () => { time += 86400000; }, calls: () => calls, notices: () => notices, ledger: async () => JSON.parse(await fs.readFile(file, 'utf8')) };
}
test('0 stalled: no execution or notification', async t => {
  const f = await fixture(t, 0); await run(options([], {}), f.io); assert.equal(f.calls(), 0); assert.equal(f.notices(), 0);
});
test('nightly limit is enforced across repeated invocations', async t => {
  const f = await fixture(t); await run(options([], {}), f.io); await run(options([], {}), f.io); assert.equal(f.calls(), 3); assert.equal(f.notices(), 1);
});
test('three attempts without progress persist skip reason', async t => {
  const f = await fixture(t, 1);
  for (let i = 0; i < 4; i++) { await run(options([], {}), f.io); f.next(); }
  assert.equal(f.calls(), 3); assert.equal((await f.ledger()).sessions['session-0'].skipReason, '3回進捗なし');
});
test('two consecutive errors abort night, including subsequent invocations', async t => {
  const f = await fixture(t); let calls = 0, message;
  f.io.execute = async () => { calls++; throw new Error('fixture error'); };
  f.io.notify = async s => { message = s; };
  assert.equal((await run(options([], {}), f.io)).aborted, true);
  await run(options([], {}), f.io); assert.equal(calls, 2); assert.match(message, /連続2件エラー/);
});
test('recently active sessions excluded using injected stat', async t => {
  const f = await fixture(t); f.io.stat = async () => ({ mtimeMs: f.io.now() - 60000 });
  assert.ok((await run(options([], {}), f.io)).rows.every(r => r.skip === 'active')); assert.equal(f.calls(), 0);
});
test('same night never resumes the same session twice', async t => {
  const f = await fixture(t, 1); await run(options([], {}), f.io); await run(options([], {}), f.io); assert.equal(f.calls(), 1);
});
test('dry-run and list leave ledger byte-for-byte unchanged', async t => {
  const f = await fixture(t); await run(options([], {}), f.io);
  const before = await fs.readFile(f.file, 'utf8'); f.next();
  await run(options(['--dry-run'], {}), f.io); await run(options(['--list'], {}), f.io);
  assert.equal(await fs.readFile(f.file, 'utf8'), before); assert.equal(f.calls(), 3);
});
test('closed and auto-close eligible sessions excluded', async t => {
  const f = await fixture(t, 2); f.io.loadClosed = async () => ({ sessions: { 'session-0': {} } });
  f.io.stat = async () => ({ mtimeMs: f.io.now() - 7 * 86400000 });
  const r = await run(options([], {}), f.io); assert.deepEqual(r.rows.map(r => r.skip), ['closed', 'session-auto-close対象']); assert.equal(f.calls(), 0);
});
test('overlapping runs cannot acquire the same lock', async t => {
  const f = await fixture(t, 1); let release, entered;
  const started = new Promise(r => { entered = r; });
  f.io.execute = async () => { entered(); await new Promise(r => { release = r; }); return { outcome: 'no-progress' }; };
  const first = run(options([], {}), f.io); await started;
  assert.equal((await run(options([], {}), f.io)).skipped, 'locked'); release(); await first;
});
test('adapter forwards deadline/resume and requires progress evidence', async () => {
  let invocation;
  const io = { executable: 'fixture', runChild: async (...args) => { invocation = args; return { status: 'success' }; }, readReport: async () => null };
  const r = { sessionId: 'abc', cwd: '/fixture', file: '/fixture/transcript' };
  assert.equal((await execute(r, { timeoutMs: 123, resultFile: '/fixture/result' }, io)).outcome, 'no-progress');
  assert.equal(invocation[4], 123); assert.equal(invocation[5].resumeSessionId, 'abc');
  io.readReport = async () => ({ progressed: true, evidence: 'Changed artifact; checks pass' });
  assert.equal((await execute(r, { timeoutMs: 123 }, io)).outcome, 'progressed');
  io.runChild = async () => ({ status: 'timeout' });
  assert.equal((await execute(r, { timeoutMs: 123 }, io)).outcome, 'error');
  assert.ok(buildClaudeHeadlessArgs({ repoCwd: '/fixture', historyCwd: '/fixture', resumeSessionId: 'abc' }).includes('--resume'));
});
test('invalid CLI/env values rejected', () => {
  for (const args of [['--limit'], ['--limit', '-1'], ['--limit', '1.5'], ['--unknown']]) assert.throws(() => options(args, {}));
  assert.throws(() => options([], { STALLED_SESSION_TIMEOUT_MIN: 'NaN' }));
});

test('CLI main consumes dry-run argv without creating state', async t => {
  const f = await fixture(t, 1);
  await main(['--dry-run'], f.io);
  await assert.rejects(fs.access(f.file), { code: 'ENOENT' });
  assert.equal(f.calls(), 0); assert.equal(f.notices(), 0);
});
test('progress clears failure budget, errors and no-progress consume it', async t => {
  const f = await fixture(t, 1); await run(options([], {}), f.io); f.next();
  f.io.execute = async () => ({ outcome: 'progressed', reason: 'artifact verified' });
  await run(options([], {}), f.io);
  assert.equal((await f.ledger()).sessions['session-0'].noProgress, 0);
});
test('nightly order and converge repair are wired', async () => {
  const batch = await fs.readFile(new URL('./nightly-batch.ps1', import.meta.url), 'utf8');
  assert.match(batch, /session-triage\.mjs[\s\S]*?if \(\$triageExit -eq 0\)[\s\S]*?stalled-session-resume\.mjs/);
  const manifest = JSON.parse(await fs.readFile(new URL('./setup-manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.items.find(i => i.id === 'task:nightly').repair, ['register-stalled-session-nightly.mjs']);
  assert.deepEqual(manifest.items.find(i => i.id === 'tool:stalled-session-resume').repair, ['onboarding-sync.mjs', '--force']);
});
