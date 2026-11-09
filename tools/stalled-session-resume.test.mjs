import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { skipReason, run, options, execute, main, resumedParentId, saveJson } from './stalled-session-resume.mjs';
import { buildClaudeHeadlessArgs } from './auto-session-executor.mjs';

async function fixture(t, count = 5) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'stalled-test-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  let time = new Date(2026, 8, 24, 3).getTime();
  let calls = 0, notices = 0;
  const records = Array.from({ length: count }, (_, i) => ({ sessionId: `session-${i}`, displayTitle: `Task ${i}`, file: `file-${i}`, cwd: home, status: '要対応', score: 100 - i, ageDays: 1 }));
  const io = { home, now: () => time, detect: async () => records, stat: async () => ({ mtimeMs: time - 86400000 }),
    execute: async () => { calls++; return { outcome: 'no-progress' }; }, notify: async () => { notices++; return { delivered: 'dm' }; } };
  const file = path.join(home, '.claude/stalled-session-resume.json');
  return { io, file, records, next: () => { time += 86400000; }, calls: () => calls, notices: () => notices, ledger: async () => JSON.parse(await fs.readFile(file, 'utf8')) };
}
test('saveJson retries two EPERM failures and uses unique temporary files', async t => {
  const f = await fixture(t, 0);
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  await fs.writeFile(f.file, JSON.stringify({ old: true }));
  const sources = []; let calls = 0;
  await saveJson(f.file, { saved: true }, async (source, destination) => {
    sources.push(source);
    if (++calls <= 2) {
      assert.deepEqual(await f.ledger(), { old: true });
      throw Object.assign(new Error('reader busy'), { code: 'EPERM' });
    }
    await fs.rename(source, destination);
  });
  assert.equal(calls, 3);
  assert.equal(new Set(sources).size, 1);
  assert.deepEqual(await f.ledger(), { saved: true });
  await saveJson(f.file, { saved: 'again' }, async (source, destination) => {
    assert.notEqual(source, sources[0]);
    await fs.rename(source, destination);
  });
  assert.deepEqual(await f.ledger(), { saved: 'again' });
  assert.deepEqual(await fs.readdir(path.dirname(f.file)), [path.basename(f.file)]);
});
test('saveJson cleans up and preserves the original error when rename fails', async t => {
  const f = await fixture(t, 0);
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  await fs.writeFile(f.file, JSON.stringify({ old: true }));
  for (const code of ['EBUSY', 'ENOENT']) {
    let calls = 0;
    const failure = Object.assign(new Error('rename failed'), { code });
    await assert.rejects(saveJson(f.file, { saved: true }, async () => {
      calls++; throw failure;
    }), error => error === failure);
    assert.equal(calls, code === 'EBUSY' ? 8 : 1);
    assert.deepEqual(await f.ledger(), { old: true });
    assert.deepEqual(await fs.readdir(path.dirname(f.file)), [path.basename(f.file)]);
  }
});
test('0 stalled: no execution or notification', async t => {
  const f = await fixture(t, 0); await run(options([], {}), f.io); assert.equal(f.calls(), 0); assert.equal(f.notices(), 0);
});
test('nightly limit is enforced across repeated invocations', async t => {
  const f = await fixture(t); await run(options(['--limit', '3'], {}), f.io); await run(options(['--limit', '3'], {}), f.io); assert.equal(f.calls(), 3); assert.equal(f.notices(), 1);
});
test('three attempts without progress persist skip reason', async t => {
  const f = await fixture(t, 1);
  for (let i = 0; i < 4; i++) { await run(options([], {}), f.io); f.next(); }
  assert.equal(f.calls(), 3); assert.equal((await f.ledger()).sessions['session-0'].skipReason, '3回進捗なし');
});
test('three consecutive errors abort night, including subsequent invocations', async t => {
  const f = await fixture(t); let calls = 0, message;
  f.io.execute = async () => { calls++; throw new Error('fixture error'); };
  f.io.notify = async s => { message = s; };
  assert.equal((await run(options([], {}), f.io)).aborted, true);
  await run(options([], {}), f.io); assert.equal(calls, 3); assert.match(message, /連続3件エラー/);
});
test('three consecutive timeouts do not abort the night', async t => {
  const f = await fixture(t); let calls = 0, message;
  f.io.execute = async () => { calls++; return { outcome: 'timeout', reason: 'timeout' }; };
  f.io.notify = async s => { message = s; };
  const r = await run(options([], {}), f.io);
  assert.equal(calls, 5); assert.equal(r.aborted, false);
  // 集計行に時間切れが入る（朝の通知: 確認 N件 / … / 時間切れ t / エラー c / …）。
  assert.match(message, /時間切れ 5/); assert.doesNotMatch(message, /連続3件エラー/);
});
test('timeout neither adds to nor resets the error streak', async t => {
  const f = await fixture(t); const outcomes = ['error', 'error', 'timeout', 'error', 'progressed']; let i = 0, message;
  f.io.execute = async () => { const outcome = outcomes[i++]; return { outcome, reason: outcome }; };
  f.io.notify = async s => { message = s; };
  const r = await run(options([], {}), f.io);
  // 2件のエラー後に timeout が挟まってもエラー連続は途切れず、3件目のエラーで今晩は中止される。
  assert.equal(r.aborted, true); assert.equal(r.results.length, 4);
  assert.match(message, /連続3件エラー/); assert.match(message, /時間切れ 1/);
});
test('timeout exception is treated as timeout not error', async t => {
  const f = await fixture(t, 3); let calls = 0, message;
  f.io.execute = async () => { calls++; throw new Error('timeout'); };
  f.io.notify = async s => { message = s; };
  const r = await run(options([], {}), f.io);
  assert.equal(calls, 3); assert.equal(r.aborted, false);
  assert.match(message, /時間切れ 3/);
  assert.doesNotMatch(message, /連続3件エラー/);
});

test('no executor stops the night without error or consuming budget', async t => {
  const f = await fixture(t); let calls = 0;
  f.io.execute = async () => { calls++; return { outcome: 'no-executor', reason: '実行役なし: cheap-code/deepseek exit 3' }; };
  const r = await run(options([], {}), f.io);
  assert.equal(calls, 1); assert.equal(r.aborted, false); assert.equal(r.results.length, 0); assert.equal(f.notices(), 1);
  assert.match(r.noExecutor, /deepseek exit 3/);
  const ledger = await f.ledger();
  assert.deepEqual(ledger.sessions['session-0'].attempts, []); assert.equal(ledger.sessions['session-0'].noProgress, 0);
  assert.equal(ledger.nights['2026-09-24'].count, 0); assert.equal(ledger.nights['2026-09-24'].errors, 0);
  // レーンが同じ晩に戻れば、同じセッションを再開できる。
  f.io.execute = async () => { calls++; return { outcome: 'progressed', reason: 'artifact verified' }; };
  const again = await run(options([], {}), f.io);
  assert.equal(again.results[0].outcome, 'progressed'); assert.equal(again.noExecutor, undefined);
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
  assert.equal(await fs.readFile(f.file, 'utf8'), before); assert.equal(f.calls(), 5);
});
test('closed sessions excluded but seven-day-old sessions resumed', async t => {
  const f = await fixture(t, 2); f.io.loadClosed = async () => ({ sessions: { 'session-0': {} } });
  f.io.stat = async () => ({ mtimeMs: f.io.now() - 7 * 86400000 });
  const r = await run(options([], {}), f.io); assert.deepEqual(r.rows.map(r => r.skip), ['closed', '']); assert.equal(f.calls(), 1);
});
test('closable sessions are not resumed', async t => {
  const f = await fixture(t, 2);
  f.records[0].displayTitle = '008｜【閉じて可】[headless:quota-sweep] Follow .loop/quota-sweep-claude.md';
  const r = await run(options([], {}), f.io);
  assert.deepEqual(r.rows.map(r => r.skip), ['閉じて可', '']);
  assert.equal(f.calls(), 1);
  assert.equal((await f.ledger()).sessions['session-0'].skipReason, '閉じて可');
});
test('sessions that asked to wait are skipped until their deadline', async t => {
  const f = await fixture(t, 1);
  const pad = n => String(n).padStart(2, '0');
  const deadline = new Date(f.io.now() + 3600000);
  f.records[0].displayTitle = `008｜【${pad(deadline.getMonth() + 1)}/${pad(deadline.getDate())}/${pad(deadline.getHours())}:${pad(deadline.getMinutes())}まで】Task 0`;
  const before = await run(options([], {}), f.io);
  assert.equal(before.rows[0].skip, '待機期限前'); assert.equal(f.calls(), 0);
  // 期限を過ぎたら再開対象に戻る（期限切れの待機を永久に無視しない）。
  f.next();
  const after = await run(options([], {}), f.io);
  assert.equal(after.rows[0].skip, ''); assert.equal(f.calls(), 1);
});
test('missing transcript is skipped without aborting the run', async t => {
  const f = await fixture(t, 2);
  f.io.stat = async file => { if (file === 'file-0') throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return { mtimeMs: f.io.now() - 86400000 }; };
  const r = await run(options([], {}), f.io);
  assert.equal(r.rows[0].skip, '会話ファイル欠損'); assert.equal(r.rows[1].skip, '');
  assert.equal(f.calls(), 1); assert.equal(r.results.length, 1);
  assert.equal((await f.ledger()).sessions['session-0'].skipReason, '会話ファイル欠損');
});
test('non-ENOENT stat errors still reject', async t => {
  const f = await fixture(t, 1);
  f.io.stat = async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
  await assert.rejects(run(options([], {}), f.io), { code: 'EACCES' });
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
  assert.equal((await execute(r, { timeoutMs: 123, resultFile: '/fixture/result' }, io)).outcome, 'no-report');
  assert.equal(invocation[4], 123); assert.equal(invocation[5].resumeSessionId, 'abc');
  io.readReport = async () => ({ progressed: true, evidence: 'Changed artifact; checks pass' });
  assert.equal((await execute(r, { timeoutMs: 123 }, io)).outcome, 'progressed');
  io.runChild = async () => ({ status: 'timeout' });
  io.readReport = async () => null;
  assert.equal((await execute(r, { timeoutMs: 123 }, io)).outcome, 'timeout');
  // 時間切れ直前に成果 JSON を保存できていれば progressed として数える。
  io.readReport = async () => ({ progressed: true, evidence: 'Saved before cutoff' });
  assert.equal((await execute(r, { timeoutMs: 123 }, io)).outcome, 'progressed');
  io.runChild = async () => ({ status: 'failure', skippedNoExecutor: true, executorUsed: 'cheap-code:deepseek', stderr: 'payment_required' });
  const lane = await execute(r, { timeoutMs: 123 }, io);
  assert.equal(lane.outcome, 'no-executor'); assert.match(lane.reason, /payment_required/);
  assert.ok(buildClaudeHeadlessArgs({ repoCwd: '/fixture', historyCwd: '/fixture', resumeSessionId: 'abc' }).includes('--resume'));
});
test('execute sanitizes control characters and handles invalid JSON in result file', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'stalled-json-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const resultFile = path.join(dir, 'result.json');
  const r = { sessionId: 'abc', cwd: dir, file: path.join(dir, 'transcript') };
  const io = { executable: 'fixture', runChild: async () => ({ status: 'success' }) };

  // Control characters stripped and successfully parsed
  await fs.writeFile(resultFile, '{\x00"progressed":\x01 true, \x1F"evidence": "Fixed\x02 bug"}');
  const res1 = await execute(r, { timeoutMs: 1000, resultFile }, io);
  assert.equal(res1.outcome, 'progressed');
  assert.equal(res1.reason, 'Fixed bug');

  // Invalid JSON handled gracefully as no-report
  await fs.writeFile(resultFile, 'invalid json {');
  const res2 = await execute(r, { timeoutMs: 1000, resultFile }, io);
  assert.equal(res2.outcome, 'no-report');

  // Structured object evidence should count as progressed
  await fs.writeFile(resultFile, JSON.stringify({ progressed: true, evidence: { findings: ['Fixed bug A', 'Verified B'], changes: ['Updated state file'] } }));
  const res3 = await execute(r, { timeoutMs: 1000, resultFile }, io);
  assert.equal(res3.outcome, 'progressed');
  assert.match(res3.reason, /Fixed bug A/);

  // Object evidence with progressed=false should be no-progress
  await fs.writeFile(resultFile, JSON.stringify({ progressed: false, evidence: { reason: 'Waiting for external input' } }));
  const res4 = await execute(r, { timeoutMs: 1000, resultFile }, io);
  assert.equal(res4.outcome, 'no-progress');
});
test('execute recognizes four states, legacy reports, timeout priority and missing reports', async () => {
  const record = { sessionId: 'abc', cwd: '/fixture' };
  let status = 'success', report;
  const io = { executable: 'fixture', runChild: async () => ({ status }), readReport: async () => report };
  const outcome = async value => { report = value; return (await execute(record, { timeoutMs: 1000 }, io)).outcome; };
  assert.equal(await outcome({ state: 'progressed', evidence: 'changed and verified' }), 'progressed');
  assert.equal(await outcome({ state: 'done', evidence: 'completed elsewhere' }), 'done');
  report = { state: 'waiting-human', evidence: 'approval is required', askId: 'ask-123' };
  const waiting = await execute(record, { timeoutMs: 1000 }, io);
  assert.equal(waiting.outcome, 'waiting-human'); assert.equal(waiting.askId, 'ask-123');
  assert.equal(await outcome({ state: 'stuck', evidence: 'cannot proceed' }), 'no-progress');
  assert.equal(await outcome({ progressed: true, evidence: 'legacy success' }), 'progressed');
  assert.equal(await outcome({ progressed: false, evidence: 'legacy failure' }), 'no-progress');
  assert.equal(await outcome({ state: 'waiting-human', evidence: 'approval is required' }), 'no-progress');
  assert.equal(await outcome(null), 'no-report');
  assert.equal(await outcome(''), 'no-report');
  status = 'timeout';
  assert.equal(await outcome({ state: 'done', evidence: 'saved before timeout' }), 'done');
  assert.equal(await outcome({ state: 'waiting-human', evidence: 'asked before timeout', askId: 'ask-456' }), 'waiting-human');
  assert.equal(await outcome({ state: 'progressed', evidence: 'saved before timeout' }), 'progressed');
  assert.equal(await outcome({ state: 'stuck', evidence: 'timed out' }), 'timeout');
});
test('done closes a session without consuming budget and the next run skips it', async t => {
  const f = await fixture(t, 1); const closed = { sessions: {} }; let closeCalls = 0;
  f.io.loadClosed = async () => closed;
  f.io.closeSession = async (sessionId, value) => { closeCalls++; closed.sessions[sessionId] ??= value; };
  f.io.execute = async () => ({ outcome: 'done', reason: 'already completed' });
  const first = await run(options([], {}), f.io);
  assert.equal(first.results[0].outcome, 'done'); assert.equal(closeCalls, 1);
  assert.equal((await f.ledger()).sessions['session-0'].noProgress, 0);
  assert.deepEqual(closed.sessions['session-0'], {
    closedAt: new Date(f.io.now()).toISOString(), reason: 'stalled-resume-done', status: '完了', title: 'Task 0', cwd: f.io.home, file: 'file-0'
  });
  f.next();
  const second = await run(options([], {}), f.io);
  assert.equal(second.rows[0].skip, 'closed'); assert.equal(second.results.length, 0); assert.equal(closeCalls, 1);
});
test('waiting-human saves ask and skips for seven days without consuming budget', async t => {
  const f = await fixture(t, 1); let time = f.io.now(); f.io.now = () => time; let calls = 0;
  f.io.execute = async () => { calls++; return { outcome: 'waiting-human', reason: 'approval pending', askId: 'ask-open' }; };
  await run(options([], {}), f.io);
  let entry = (await f.ledger()).sessions['session-0'];
  assert.equal(entry.noProgress, 0); assert.deepEqual(entry.waitingHuman, { askId: 'ask-open', until: time + 7 * 86400000 });
  time += 7 * 86400000 - 1;
  assert.equal((await run(options([], {}), f.io)).rows[0].skip, '人の判断待ち'); assert.equal(calls, 1);
  time += 1;
  assert.equal((await run(options([], {}), f.io)).results[0].outcome, 'waiting-human'); assert.equal(calls, 2);
});
test('clean results do not notify and record all-clean', async t => {
  const f = await fixture(t, 2);
  f.io.execute = async record => record.sessionId === 'session-0'
    ? { outcome: 'done', reason: 'complete' }
    : { outcome: 'waiting-human', reason: 'approval pending', askId: 'ask-clean' };
  const result = await run(options([], {}), f.io);
  assert.deepEqual(result.results.map(r => r.outcome), ['done', 'waiting-human']); assert.equal(f.notices(), 0);
  assert.deepEqual((await f.ledger()).nights['2026-09-24'].notification, { skipped: 'all-clean' });
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
test('resumedParentId reads the parent id from the runner prompt only', () => {
  assert.equal(resumedParentId('停滞セッション「Task 0」(session-0)の承認済みの目的を1歩進めてください。'), 'session-0');
  assert.equal(resumedParentId('停滞セッション「A」の承認済みの目的を1歩進めてください。'), '');
  assert.equal(resumedParentId('普通の依頼です'), '');
  assert.equal(resumedParentId(undefined), '');
});
test('resume chain shares the 3-strike budget across changing session ids', async t => {
  const f = await fixture(t, 1);
  const promptFor = id => `停滞セッション「Task 0」(${id})の承認済みの目的を1歩進めてください。当初依頼: x`;
  await run(options([], {}), f.io); // night 1: session-0 noProgress=1
  f.records.length = 0;
  for (const [night, sessionId, parentId] of [[2, 'child-1', 'session-0'], [3, 'child-2', 'child-1'], [4, 'child-3', 'child-2']]) {
    f.next();
    // 実運用では前夜までの子はもう停滞一覧に残らない（新しい子に置き換わる）。
    f.records.splice(0, f.records.length, { sessionId, displayTitle: 'Task 0', file: `file-${sessionId}`, cwd: f.io.home, status: '要対応', score: 90, ageDays: 1, firstPrompt: promptFor(parentId) });
    const r = await run(options([], {}), f.io);
    if (night === 4) {
      // 祖先の積み上げで、毎晩 id が変わっても4夜目には retire される。
      assert.equal(f.calls(), 3);
      assert.equal(r.rows[0].skip, '3回進捗なし');
      assert.equal(r.results.length, 0);
    }
  }
  const ledger = await f.ledger();
  assert.equal(ledger.sessions['child-2'].noProgress, 3);
  assert.equal(ledger.sessions['child-2'].parentSessionId, 'child-1');
  assert.equal(ledger.sessions['session-0'].noProgress, 3);
});
test('progress on a chain child resets the shared budget', async t => {
  const f = await fixture(t, 1);
  await run(options([], {}), f.io); // session-0 noProgress=1
  f.next();
  f.records.length = 0;
  f.records.push({ sessionId: 'child-1', displayTitle: 'Task 0', file: 'file-child-1', cwd: f.io.home, status: '要対応', score: 90, ageDays: 1,
    firstPrompt: '停滞セッション「Task 0」(session-0)の承認済みの目的を1歩進めてください。' });
  f.io.execute = async () => ({ outcome: 'progressed', reason: 'artifact verified' });
  await run(options([], {}), f.io);
  const ledger = await f.ledger();
  assert.equal(ledger.sessions['child-1'].noProgress, 0);
  assert.equal(ledger.sessions['session-0'].noProgress, 0);
});
test('nightly order and converge repair are wired', async () => {
  const batch = await fs.readFile(new URL('./nightly-batch.ps1', import.meta.url), 'utf8');
  assert.match(batch, /Write-NightlyLog 'stalled-session-resume' 'moved:OrgiastStalledSessionSweep'/);
  assert.doesNotMatch(batch, /stalled-session-resume\.mjs/);
  const manifest = JSON.parse(await fs.readFile(new URL('./setup-manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.items.find(i => i.id === 'task:nightly').repair, ['register-stalled-session-nightly.mjs']);
  assert.deepEqual(manifest.items.find(i => i.id === 'tool:stalled-session-resume').repair, ['onboarding-sync.mjs', '--force']);
});

test('unlimited defaults, all and numeric limits; concurrency and deadline validation', async t => {
  assert.equal(options([], {}).limit, Infinity);
  assert.equal(options(['--limit', 'all'], {}).limit, Infinity);
  assert.equal(options([], { STALLED_SESSION_LIMIT: '4' }).limit, 4);
  assert.equal(options([], { STALLED_SESSION_CONCURRENCY: '3', STALLED_SESSION_DEADLINE: '06:15' }).concurrency, 3);
  for (const args of [['--concurrency', '0'], ['--concurrency', '1.5'], ['--deadline', '24:00'], ['--deadline'], ['--limit', 'Infinity']]) assert.throws(() => options(args, {}));
  const f = await fixture(t, 8); await run(options([], {}), f.io); assert.equal(f.calls(), 8);
});

test('deadline stops new launches and next night prioritizes unattempted sessions', async t => {
  const f = await fixture(t, 4); let time = f.io.now(); const started = [];
  f.io.now = () => time;
  f.io.execute = async record => { started.push(record.sessionId); time += 5 * 3600000; return { outcome: 'progressed' }; };
  const r = await run(options([], {}), f.io);
  assert.equal(r.results.length, 1);
  assert.equal(r.rows.filter(row => row.skip === '締切超過(翌晩へ)').length, 3);
  time = new Date(2026, 8, 25, 3).getTime();
  await run(options(['--limit', '1'], {}), f.io);
  assert.deepEqual(started, ['session-0', 'session-1']);
});

test('fair order uses oldest last night then score and age', async t => {
  const f = await fixture(t, 4);
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  await fs.writeFile(f.file, JSON.stringify({ version: 1, nights: {}, sessions: {
    'session-0': { attempts: [{ night: '2026-09-23' }], noProgress: 0 },
    'session-1': { attempts: [{ night: '2026-09-22' }], noProgress: 0 }
  } }));
  f.records[2].score = f.records[3].score; f.records[2].ageDays = 2;
  const r = await run(options(['--list'], {}), f.io);
  assert.deepEqual(r.rows.map(r => r.sessionId), ['session-3', 'session-2', 'session-1', 'session-0']);
});

test('parallel execution excludes shared cwd and persists attempts before launch', { timeout: 30000 }, async t => {
  const f = await fixture(t, 4); f.records[2].cwd = path.join(f.io.home, 'other');
  const active = new Set(); let max = 0, entered = 0, release;
  const bothStarted = new Promise(resolve => { release = resolve; });
  f.io.execute = async record => {
    assert.ok(!active.has(record.cwd)); active.add(record.cwd); max = Math.max(max, active.size);
    assert.equal((await f.ledger()).sessions[record.sessionId].attempts.at(-1).outcome, 'interrupted');
    // Disk persistence on Windows can exceed 20ms; synchronize actual launches.
    if (++entered === 2) release();
    await bothStarted; active.delete(record.cwd);
    return { outcome: 'progressed' };
  };
  const r = await run(options([], {}), f.io);
  assert.equal(max, 2); assert.equal(r.results.length, 4); assert.equal((await f.ledger()).nights['2026-09-24'].count, 4);
});

test('no executor prevents further launches and waits for running children', async t => {
  const f = await fixture(t, 4); f.records.forEach((r, i) => { r.cwd = path.join(f.io.home, String(i)); });
  const started = []; let release, entered;
  const both = new Promise(resolve => { entered = resolve; });
  f.io.execute = async record => {
    started.push(record.sessionId);
    if (record.sessionId === 'session-0') { await both; return { outcome: 'no-executor', reason: 'offline' }; }
    entered(); await new Promise(resolve => { release = resolve; }); return { outcome: 'progressed' };
  };
  const running = run(options([], {}), f.io);
  await both; await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(started.length, 2); release();
  const r = await running; assert.equal(r.results.length, 1); assert.equal(started.length, 2);
  assert.equal((await f.ledger()).sessions['session-0'].attempts.length, 0);
});

test('zero results still report retired sessions, excluding closed, at most twenty', async t => {
  const f = await fixture(t, 25); let message;
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  await fs.writeFile(f.file, JSON.stringify({ version: 1, nights: {}, sessions: Object.fromEntries(f.records.map(r => [r.sessionId, { title: r.displayTitle, attempts: [], noProgress: 3 }])) }));
  f.io.loadClosed = async () => ({ sessions: { 'session-0': {} } });
  f.io.notify = async value => { message = value; };
  const r = await run(options([], {}), f.io);
  assert.equal(r.results.length, 0); assert.match(message, /確認 0件.*停止中 24/);
  assert.match(message, /自動では進められないので kim の判断待ち/);
  assert.equal((message.match(/Task \d+ \(session-\d+\)/g) ?? []).length, 20);
  assert.doesNotMatch(message, /\(session-0\)/);
});

test('dedicated sweep registration and required converge manifest', async () => {
  const ps = await fs.readFile(new URL('./register-stalled-session-nightly.ps1', import.meta.url), 'utf8');
  for (const name of ['OrgiastNightlyBatch', 'OrgiastStalledSessionSweep']) {
    assert.ok(ps.includes(`Register-ScheduledTask -TaskName '${name}'`));
    assert.ok(ps.includes(`Get-ScheduledTask -TaskName '${name}'`));
  }
  assert.match(ps, /Get-Command node -CommandType Application.*Where-Object Extension -eq '\.exe'.*\.Source/);
  assert.ok(ps.includes("if (-not $node) { throw 'node.exe not found' }"));
  assert.ok(ps.includes("$sweepScript = Join-Path $repo 'tools\\stalled-session-resume.mjs'"));
  assert.match(ps, /& \$node --check \$sweepScript\s+if \(\$LASTEXITCODE -ne 0\) \{ throw "node --check failed: \$sweepScript" \}/);
  assert.ok(ps.indexOf('& $node --check $sweepScript') < ps.indexOf('Register-ScheduledTask'));
  assert.match(ps, /New-HiddenScheduledTaskAction -Execute \$node -ChildArgument @\(\$sweepScript\) -WorkingDirectory \$repo/);
  assert.match(ps, /-At 3:05am -RandomDelay \(New-TimeSpan -Minutes 2\)/);
  assert.match(ps, /-StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit \(New-TimeSpan -Hours 5\)/);
  const manifest = JSON.parse(await fs.readFile(new URL('./setup-manifest.json', import.meta.url), 'utf8'));
  const sweep = manifest.items.find(i => i.id === 'task:stalled-session-sweep');
  assert.equal(sweep.severity, 'required'); assert.equal(sweep.type, 'scheduled-task');
  assert.deepEqual(sweep.spec, { requireActionTarget: true, maxRunAgeHours: 50, name: 'OrgiastStalledSessionSweep' });
  assert.deepEqual(sweep.repair, ['register-stalled-session-nightly.mjs']);
});

test('three errors in completion order stop launches even if an in-flight child later progresses', async t => {
  const f = await fixture(t, 7); const started = []; const resolvers = new Map();
  f.records.forEach((r, i) => { r.cwd = path.join(f.io.home, String(i)); });
  const waitFor = async n => { for (let i = 0; started.length < n && i < 200; i++) await new Promise(r => setTimeout(r, 5)); assert.equal(started.length, n); };
  f.io.execute = record => { started.push(record.sessionId); return new Promise(resolve => resolvers.set(record.sessionId, resolve)); };
  const running = run(options(['--concurrency', '4'], {}), f.io);
  await waitFor(4);
  for (const id of ['session-2', 'session-1', 'session-0']) {
    resolvers.get(id)({ outcome: 'error' });
  }
  await new Promise(r => setTimeout(r, 30));
  resolvers.get('session-3')({ outcome: 'progressed' });
  const result = await running;
  assert.equal(result.aborted, true); assert.equal(started.length, 4);
  assert.deepEqual(result.results.map(r => r.sessionId), ['session-2', 'session-1', 'session-0', 'session-3']);
});

test('overdue selects only expired waits, excludes closed/closable/active and ignores nightly deadline', async t => {
  const f = await fixture(t, 6);
  f.io.now = () => new Date(2026, 8, 24, 14).getTime();
  f.records.forEach(r => { r.displayTitle = '008｜【09/24/12:00まで】' + r.displayTitle; });
  f.records[0].status = '参考';
  f.records[1].displayTitle = '【09/24/15:00まで】Future';
  f.records[2].displayTitle = 'Ordinary';
  f.records[3].displayTitle = '【閉じて可】Done';
  f.io.loadClosed = async () => ({ sessions: { 'session-4': {} } });
  f.io.stat = async file => ({ mtimeMs: f.io.now() - (file === 'file-5' ? 1000 : 86400000) });
  const r = await run(options(['--overdue'], {}), f.io);
  assert.deepEqual(r.results.map(r => r.sessionId), ['session-0']);
  assert.equal(f.notices(), 1);
  assert.deepEqual((await f.ledger()).nights, {});
  assert.deepEqual((await f.ledger()).sessions, {});
});
test('overdue defaults, per-invocation cap, dedupe and changed deadline', async t => {
  const f = await fixture(t, 3);
  f.records.forEach(r => { r.displayTitle = '【09/23/12:00まで】' + r.displayTitle; });
  const config = options([], { STALLED_SESSION_MODE: 'overdue', STALLED_SESSION_CONCURRENCY: '9' });
  assert.equal(config.limit, 2); assert.equal(config.concurrency, 1);
  assert.equal((await run(config, f.io)).results.length, 2);
  assert.equal((await run(config, f.io)).results.length, 1);
  assert.equal((await run(config, f.io)).results.length, 0);
  assert.equal(f.notices(), 2);
  f.records[0].displayTitle = '【09/23/13:00まで】New deadline';
  assert.deepEqual((await run(config, f.io)).results.map(r => r.sessionId), ['session-0']);
});
test('overdue errors back off for 30 minutes, stop at three, and never affect nights', async t => {
  const f = await fixture(t, 1); let time = f.io.now();
  f.io.now = () => time;
  f.records[0].displayTitle = '【09/23/12:00まで】Task';
  f.io.execute = async () => ({ outcome: 'error', executor: 'cheap-code:glm', reason: 'timeout' });
  const config = options(['--overdue'], {});
  await run(config, f.io);
  time += 30 * 60000 - 1;
  assert.equal((await run(config, f.io)).results.length, 0);
  time++;
  assert.equal((await run(config, f.io)).results.length, 1);
  time += 30 * 60000;
  assert.equal((await run(config, f.io)).results.length, 1);
  time += 30 * 60000;
  assert.equal((await run(config, f.io)).rows[0].skip, '同一期限3回エラー');
  assert.deepEqual((await f.ledger()).nights, {});
  assert.deepEqual((await f.ledger()).sessions, {});
  f.io.execute = async () => ({ outcome: 'progressed' });
  assert.equal((await run(options([], {}), f.io)).results.length, 1);
});
test('overdue dry-run preserves ledger and does not notify or execute', async t => {
  const f = await fixture(t, 1);
  f.records[0].displayTitle = '【09/23/12:00まで】Task';
  await run(options(['--overdue', '--dry-run'], {}), f.io);
  await assert.rejects(fs.access(f.file), { code: 'ENOENT' });
  assert.equal(f.calls(), 0); assert.equal(f.notices(), 0);
});
test('nightly prioritizes overdue titles over score', async t => {
  const f = await fixture(t, 2);
  f.records[1].displayTitle = '【09/23/12:00まで】Urgent';
  const r = await run(options(['--limit', '1'], {}), f.io);
  assert.equal(r.results[0].sessionId, 'session-1');
});
test('executor metadata survives timeout/failure/success and overdue prompt carries action context', async () => {
  for (const status of ['timeout', 'failure', 'success']) {
    let prompt;
    const executorAttempts = [{ executor: 'cheap-code:deepseek', status: 'timeout' }, { executor: 'cheap-code:glm', status }];
    const result = await execute({ sessionId: 'test', cwd: '/fixture' }, { timeoutMs: 1000, wait: { label: '09/23 12:00' } }, {
      executable: 'fixture', runChild: async (_, text) => { prompt = text; return { status, executorUsed: 'cheap-code:glm', executorAttempts }; }, readReport: async () => null
    });
    assert.equal(result.executor, 'cheap-code:glm'); assert.deepEqual(result.executorAttempts, executorAttempts);
    assert.match(prompt, /待機期限 09\/23 12:00/); assert.match(prompt, /node tools\/kim-inbox.mjs/); assert.match(prompt, /期限を書き換えるだけで終えない/);
  }
});
test('exceptions retain explicit not-started executor in persisted attempt', async t => {
  const f = await fixture(t, 1); f.io.execute = async () => { throw new Error('launch failed'); };
  await run(options([], {}), f.io);
  assert.equal((await f.ledger()).sessions['session-0'].attempts[0].executor, 'not-started');
});
test('overdue task uses hidden runner, 15 minute trigger and verified settings with required repair', async () => {
  const ps = await fs.readFile(new URL('./register-stalled-session-nightly.ps1', import.meta.url), 'utf8');
  assert.match(ps, /New-HiddenScheduledTaskAction -Execute \$node -ChildArgument @\(\$sweepScript, '--overdue'\)/);
  assert.match(ps, /-RepetitionInterval \(New-TimeSpan -Minutes 15\)/);
  assert.match(ps, /-MultipleInstances IgnoreNew -ExecutionTimeLimit \(New-TimeSpan -Hours 2\)/);
  assert.match(ps, /Get-ScheduledTask -TaskName 'OrgiastWaitDeadlineResume'/);
  assert.match(ps, /\$waitTask.Actions.Arguments -ne \$waitAction.Arguments/);
  assert.match(ps, /\$waitTask.Triggers\[0\].Repetition.Interval -ne 'PT15M'/);
  assert.match(ps, /\$waitTask.Settings.StartWhenAvailable/);
  const manifest = JSON.parse(await fs.readFile(new URL('./setup-manifest.json', import.meta.url), 'utf8'));
  const item = manifest.items.find(i => i.id === 'task:wait-deadline-resume');
  assert.equal(item.severity, 'required'); assert.equal(item.spec.name, 'OrgiastWaitDeadlineResume');
  assert.deepEqual(item.repair, ['register-stalled-session-nightly.mjs']);
});

test('report parse failure keeps the actual executor', async () => {
  const result = await execute({ sessionId: 'test', cwd: '/fixture' }, { timeoutMs: 1000 }, {
    executable: 'fixture', runChild: async () => ({ status: 'success', executorUsed: 'cheap-code:deepseek' }),
    readReport: async () => { throw new Error('invalid JSON'); }
  });
  assert.equal(result.outcome, 'error'); assert.equal(result.executor, 'cheap-code:deepseek');
});
test('nightly abort and retired budget do not prevent overdue; old interrupted attempt is retried', async t => {
  const f = await fixture(t, 1);
  f.records[0].displayTitle = '【09/23/12:00まで】Task';
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  const nights = { '2026-09-24': { count: 3, errors: 3, aborted: true } };
  await fs.writeFile(f.file, JSON.stringify({ version: 1, nights, sessions: { 'session-0': { noProgress: 3, attempts: [] } } }));
  await run(options(['--overdue'], {}), f.io);
  const ledger = await f.ledger();
  assert.equal(f.calls(), 1); assert.deepEqual(ledger.nights, nights);
  // Old interrupted (30分超) は再試行対象
  const overdueKey = Object.keys(ledger.overdue)[0];
  ledger.overdue[overdueKey].attempts[0].outcome = 'interrupted';
  const oldTime = new Date(f.io.now() - 40 * 60000).toISOString();
  ledger.overdue[overdueKey].attempts[0].startedAt = oldTime;
  ledger.overdue[overdueKey].attempts[0].endedAt = oldTime;
  await fs.writeFile(f.file, JSON.stringify(ledger));
  assert.equal((await run(options(['--overdue'], {}), f.io)).rows[0].skip, '');
  assert.equal(f.calls(), 2);
});
test('recent interrupted overdue attempt is not replayed (30分以内)', async t => {
  const f = await fixture(t, 1);
  f.records[0].displayTitle = '【09/23/12:00まで】Task';
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  await fs.writeFile(f.file, JSON.stringify({ version: 1, nights: {}, sessions: {} }));
  await run(options(['--overdue'], {}), f.io);
  const ledger = await f.ledger();
  const overdueKey = Object.keys(ledger.overdue)[0];
  ledger.overdue[overdueKey].attempts[0].outcome = 'interrupted';
  ledger.overdue[overdueKey].attempts[0].startedAt = new Date(f.io.now() - 10 * 60000).toISOString();
  await fs.writeFile(f.file, JSON.stringify(ledger));
  assert.equal((await run(options(['--overdue'], {}), f.io)).rows[0].skip, 'エラー後30分待機');
  assert.equal(f.calls(), 1);
});
test('overdue timeout is retried (not treated as processed)', async t => {
  const f = await fixture(t, 1); let time = f.io.now();
  f.io.now = () => time;
  f.records[0].displayTitle = '【09/23/12:00まで】Task';
  let callCount = 0;
  f.io.execute = async () => { callCount++; return { outcome: 'timeout', reason: 'timeout' }; };
  const config = options(['--overdue'], {});
  const r1 = await run(config, f.io);
  assert.equal(r1.results[0].outcome, 'timeout');
  assert.equal(callCount, 1);
  // timeout は再試行対象（同一期限処理済みにならない）。30分バックオフ後に再試行される。
  time += 31 * 60000;
  const r2 = await run(config, f.io);
  assert.equal(r2.results[0].outcome, 'timeout');
  assert.equal(callCount, 2);
});
test('overdue timeout respects 30-minute backoff', async t => {
  const f = await fixture(t, 1); let time = f.io.now(); let callCount = 0;
  f.io.now = () => time;
  f.records[0].displayTitle = '【09/23/12:00まで】Task';
  f.io.execute = async () => { callCount++; return { outcome: 'timeout', reason: 'timeout' }; };
  const config = options(['--overdue'], {});
  await run(config, f.io);
  assert.equal(callCount, 1);
  time += 30 * 60000 - 1;
  assert.equal((await run(config, f.io)).results.length, 0);
  time++;
  assert.equal((await run(config, f.io)).results.length, 1);
  assert.equal(callCount, 2);
});
test('overdue timeout stops at 3 failures and notifies once', async t => {
  const f = await fixture(t, 1); let time = f.io.now(); let notices = []; let callCount = 0;
  f.io.now = () => time;
  f.records[0].displayTitle = '【09/23/12:00まで】Task';
  f.io.execute = async () => { callCount++; return { outcome: 'timeout', reason: 'timeout' }; };
  f.io.notify = async msg => { notices.push(msg); return { delivered: 'dm' }; };
  const config = options(['--overdue'], {});
  // 1回目
  await run(config, f.io); time += 31 * 60000;
  // 2回目
  await run(config, f.io); time += 31 * 60000;
  // 3回目 → 3回目の実行（まだ attempts.length=2 なので実行される）
  const r3 = await run(config, f.io);
  assert.equal(r3.results.length, 1);
  assert.equal(r3.results[0].outcome, 'timeout');
  assert.equal(callCount, 3);
  // 通知に3回失敗のメッセージが1回だけ含まれる
  const failureNotices = notices.filter(n => n.includes('3回失敗'));
  assert.equal(failureNotices.length, 1);
  // 4回目 → attempts.length=3 で停止
  time += 31 * 60000;
  assert.equal((await run(config, f.io)).rows[0].skip, '同一期限3回エラー');
  const failureNotices2 = notices.filter(n => n.includes('3回失敗'));
  assert.equal(failureNotices2.length, 1); // 重複通知なし
});
test('overdue progressed and no-progress are not retried', async t => {
  const f = await fixture(t, 2);
  f.records.forEach(r => { r.displayTitle = '【09/23/12:00まで】' + r.displayTitle; });
  let callCount = 0;
  f.io.execute = async () => { callCount++; return { outcome: callCount === 1 ? 'progressed' : 'no-progress', reason: 'done' }; };
  const config = options(['--overdue'], {});
  await run(config, f.io);
  assert.equal(callCount, 2);
  // progressed と no-progress は再試行しない
  assert.equal((await run(config, f.io)).results.length, 0);
  assert.equal(callCount, 2);
});
test('old ledger timeout outcome is retried (treated as error)', async t => {
  const f = await fixture(t, 1);
  f.records[0].displayTitle = '【09/23/12:00まで】Task';
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  // 旧台帳に timeout が入っている状態を模擬（endedAt は 40分前 → 30分バックオフ超過）
  const overdueKey = JSON.stringify(['session-0', '【09/23/12:00まで】']);
  await fs.writeFile(f.file, JSON.stringify({ version: 1, nights: {}, sessions: {}, overdue: {
    [overdueKey]: { attempts: [{ outcome: 'timeout', reason: 'timeout', startedAt: new Date(f.io.now() - 45 * 60000).toISOString(), endedAt: new Date(f.io.now() - 40 * 60000).toISOString() }], noProgress: 1 }
  } }));
  // timeout は再試行対象
  assert.equal((await run(options(['--overdue'], {}), f.io)).rows[0].skip, '');
  assert.equal(f.calls(), 1);
});
test('overdue 3rd attempt progressed does not notify and does not block retry', async t => {
  const f = await fixture(t, 1); let time = f.io.now(); let notices = []; let callCount = 0;
  f.io.now = () => time;
  f.records[0].displayTitle = '【09/23/12:00まで】Task';
  f.io.execute = async () => { callCount++; return { outcome: callCount === 3 ? 'progressed' : 'timeout', reason: 'timeout' }; };
  f.io.notify = async msg => { notices.push(msg); return { delivered: 'dm' }; };
  const config = options(['--overdue'], {});
  // 1回目: timeout
  await run(config, f.io); time += 31 * 60000;
  // 2回目: timeout
  await run(config, f.io); time += 31 * 60000;
  // 3回目: progressed → 通知なし、同一期限処理済みになる
  const r3 = await run(config, f.io);
  assert.equal(r3.results[0].outcome, 'progressed');
  assert.equal(callCount, 3);
  const failureNotices = notices.filter(n => n.includes('3回失敗'));
  assert.equal(failureNotices.length, 0);
  // progressed なので再試行しない
  time += 31 * 60000;
  assert.equal((await run(config, f.io)).results.length, 0);
});
test('overdue 3rd attempt no-progress does not notify and does not block retry', async t => {
  const f = await fixture(t, 1); let time = f.io.now(); let notices = []; let callCount = 0;
  f.io.now = () => time;
  f.records[0].displayTitle = '【09/23/12:00まで】Task';
  f.io.execute = async () => { callCount++; return { outcome: callCount === 3 ? 'no-progress' : 'timeout', reason: 'done' }; };
  f.io.notify = async msg => { notices.push(msg); return { delivered: 'dm' }; };
  const config = options(['--overdue'], {});
  await run(config, f.io); time += 31 * 60000;
  await run(config, f.io); time += 31 * 60000;
  const r3 = await run(config, f.io);
  assert.equal(r3.results[0].outcome, 'no-progress');
  assert.equal(callCount, 3);
  const failureNotices = notices.filter(n => n.includes('3回失敗'));
  assert.equal(failureNotices.length, 0);
  // no-progress も成功扱いなので再試行しない
  time += 31 * 60000;
  assert.equal((await run(config, f.io)).results.length, 0);
});

// --- pid 再利用対策と実行ログのテスト ---

test('lock pid is a different command: steals lock and executes', async t => {
  const f = await fixture(t, 1);
  // acquireLock をバイパスして lock ファイルを事前に作成。
  // 現在のプロセスの pid（alive）を使うと acquireLock は null を返し、
  // カスタムの stale lock 回復コード（processCommandLine 確認）が動く。
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  await fs.writeFile(`${f.file}.lock`, String(process.pid));
  // processCommandLine が別コマンド（stalled-session-resume を含まない）を返す
  f.io.processCommandLine = async pid => `C:\\Windows\\System32\\notepad.exe`;
  const result = await run(options([], {}), f.io);
  assert.equal(result.skipped, undefined); // lock を奪い取って実行された
  assert.equal(f.calls(), 1);
  assert.equal(result.results.length, 1);
  // 実行ログが書かれている
  const logFile = path.join(f.io.home, '.claude', 'logs', 'stalled-session-sweep.jsonl');
  const log = JSON.parse(await fs.readFile(logFile, 'utf8'));
  assert.equal(log.outcome, 'ran');
  assert.equal(log.night, '2026-09-24');
  assert.equal(log.pid, process.pid);
  assert.ok(log.counts['no-progress'] >= 1);
  // reclaimedLock が記録されている（lockOwner ではない）
  assert.ok(log.reclaimedLock);
  assert.equal(log.reclaimedLock.pid, process.pid);
  assert.equal(log.reclaimedLock.alive, false);
  assert.equal(log.lockOwner, undefined);
});

test('stale lock reclaimed: outcome ran, reclaimedLock present, no notify, no exitCode 3', async t => {
  const f = await fixture(t, 1);
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  // 現在のプロセスの pid（alive）で lock ファイルを作る → acquireLock が null を返す
  await fs.writeFile(`${f.file}.lock`, String(process.pid));
  f.io.processCommandLine = async pid => `C:\\Windows\\System32\\notepad.exe`;
  let notified = false;
  f.io.notify = async () => { notified = true; };
  const prevExitCode = process.exitCode;
  process.exitCode = 0;
  const result = await run(options([], {}), f.io);
  assert.equal(result.skipped, undefined); // lock を奪い取って実行された
  assert.equal(f.calls(), 1);
  assert.equal(result.results.length, 1);
  assert.equal(result.results[0].outcome, 'no-progress');
  // no-progress の結果があるので通知は送られる（locked の通知ではない）
  assert.equal(notified, true);
  assert.equal(process.exitCode, 0);
  // 実行ログを確認
  const logFile = path.join(f.io.home, '.claude', 'logs', 'stalled-session-sweep.jsonl');
  const lines = (await fs.readFile(logFile, 'utf8')).trim().split('\n');
  const log = JSON.parse(lines[lines.length - 1]);
  assert.equal(log.outcome, 'ran');
  assert.ok(log.reclaimedLock);
  assert.equal(log.reclaimedLock.pid, process.pid);
  assert.equal(log.reclaimedLock.alive, false);
  assert.equal(log.lockOwner, undefined);
  process.exitCode = prevExitCode;
});

test('same process running: locked with log, notify, exitCode 3', async t => {
  const f = await fixture(t, 1);
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  await fs.writeFile(`${f.file}.lock`, String(process.pid));
  // processCommandLine が自分自身（stalled-session-resume を含む）を返す
  f.io.processCommandLine = async pid => `node ${process.argv[1]}`;
  let notified = '';
  f.io.notify = async msg => { notified = msg; };
  const result = await run(options([], {}), f.io);
  assert.equal(result.skipped, 'locked');
  assert.equal(f.calls(), 0);
  assert.ok(notified.includes('locked by pid'));
  assert.equal(process.exitCode, 3);
  // 実行ログが書かれている
  const logFile = path.join(f.io.home, '.claude', 'logs', 'stalled-session-sweep.jsonl');
  const log = JSON.parse(await fs.readFile(logFile, 'utf8'));
  assert.equal(log.outcome, 'locked');
  assert.equal(log.lockOwner.pid, process.pid);
  assert.equal(log.lockOwner.alive, true);
  // exitCode を戻す（後続テストに影響しないように）
  process.exitCode = 0;
});

test('normal run writes log with counts', async t => {
  const f = await fixture(t, 3);
  f.io.execute = async record => record.sessionId === 'session-0'
    ? { outcome: 'progressed', reason: 'fixed' }
    : { outcome: 'no-progress', reason: 'stuck' };
  const result = await run(options([], {}), f.io);
  assert.equal(result.results.length, 3);
  // 実行ログを確認
  const logFile = path.join(f.io.home, '.claude', 'logs', 'stalled-session-sweep.jsonl');
  const lines = (await fs.readFile(logFile, 'utf8')).trim().split('\n');
  const log = JSON.parse(lines[lines.length - 1]); // 最後の行（今回の run）
  assert.equal(log.outcome, 'ran');
  assert.equal(log.night, '2026-09-24');
  assert.equal(log.counts['progressed'], 1);
  assert.equal(log.counts['no-progress'], 2);
  assert.equal(log.host, os.hostname());
  assert.equal(log.pid, process.pid);
  assert.equal(log.mode, 'run');
});

test('log line redacts secrets in cmdline via lockOwner', async t => {
  const f = await fixture(t, 1);
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  await fs.writeFile(`${f.file}.lock`, String(99999));
  f.io.processCommandLine = async () => `node tools/stalled-session-resume.mjs --token ghp_abcdefghijklmnopqrstuvwxyz123`;
  f.io.notify = async () => {};
  const result = await run(options([], {}), f.io);
  // stale lock (pid 99999, cmdline doesn't contain stalled-session-resume) is stolen,
  // so result.skipped is undefined. Check the log file directly.
  const logFile = path.join(f.io.home, '.claude', 'logs', 'stalled-session-sweep.jsonl');
  const lines = (await fs.readFile(logFile, 'utf8')).trim().split('\n');
  const log = JSON.parse(lines[lines.length - 1]);
  assert.equal(log.outcome, 'ran');
  process.exitCode = 0;
});

test('all-skip normal run has outcome ran and no notification', async t => {
  const f = await fixture(t, 2);
  f.io.stat = async () => ({ mtimeMs: f.io.now() - 60000 }); // all active → all skipped
  let notified = false;
  f.io.notify = async () => { notified = true; };
  const result = await run(options([], {}), f.io);
  assert.equal(result.results.length, 0);
  assert.equal(notified, false);
  const logFile = path.join(f.io.home, '.claude', 'logs', 'stalled-session-sweep.jsonl');
  const lines = (await fs.readFile(logFile, 'utf8')).trim().split('\n');
  const log = JSON.parse(lines[lines.length - 1]);
  assert.equal(log.outcome, 'ran');
  assert.ok(log.counts['skipped:active'] >= 2);
});

test('exception in run produces outcome error, notifyKim, and exitCode 3', async t => {
  const f = await fixture(t, 1);
  let notifiedMsg = '';
  f.io.notify = async msg => { notifiedMsg = msg; };
  f.io.stat = async () => { throw Object.assign(new Error('disk failure'), { code: 'EIO' }); };
  await assert.rejects(run(options([], {}), f.io), { code: 'EIO' });
  assert.ok(notifiedMsg.includes('途中で失敗'));
  assert.ok(notifiedMsg.includes('disk failure'));
  assert.equal(process.exitCode, 3);
  const logFile = path.join(f.io.home, '.claude', 'logs', 'stalled-session-sweep.jsonl');
  const lines = (await fs.readFile(logFile, 'utf8')).trim().split('\n');
  const log = JSON.parse(lines[lines.length - 1]);
  assert.equal(log.outcome, 'error');
  assert.ok(log.error.includes('disk failure'));
  process.exitCode = 0;
});

test('closed ledger と古いタイトルより最新待機フッターを優先する', () => {
  const record = { sessionId: 'reopened', displayTitle: '【閉じて可】案件', lastAssistantText: '次に kim がすること: なし\nこの後の自動進行: 毎時確認\nこのセッション: まだ閉じない（作業中・2026-11-10 18:00 まで待つ）' };
  const closed = { sessions: { reopened: {} } };
  assert.equal(skipReason(record, {}, '', closed, 0, new Date(2026, 10, 10, 19).getTime(), 1), '');
  assert.notEqual(skipReason(record, {}, '', closed, 0, new Date(2026, 10, 10, 17).getTime(), 1), 'closed');
  assert.equal(skipReason({ ...record, lastAssistantText: '' }, {}, '', closed, 0, Date.now(), 1), 'closed');
});
