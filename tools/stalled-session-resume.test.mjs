import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { run, options, execute, main, resumedParentId, saveJson } from './stalled-session-resume.mjs';
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
  const f = await fixture(t); await run(options(['--limit', '3'], {}), f.io); await run(options(['--limit', '3'], {}), f.io); assert.equal(f.calls(), 3); assert.equal(f.notices(), 2);
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
  assert.equal((await execute(r, { timeoutMs: 123, resultFile: '/fixture/result' }, io)).outcome, 'no-progress');
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

  // Invalid JSON handled gracefully as no-progress
  await fs.writeFile(resultFile, 'invalid json {');
  const res2 = await execute(r, { timeoutMs: 1000, resultFile }, io);
  assert.equal(res2.outcome, 'no-progress');
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
test('nightly abort and retired budget do not prevent overdue; interrupted attempt is not replayed', async t => {
  const f = await fixture(t, 1);
  f.records[0].displayTitle = '【09/23/12:00まで】Task';
  await fs.mkdir(path.dirname(f.file), { recursive: true });
  const nights = { '2026-09-24': { count: 3, errors: 3, aborted: true } };
  await fs.writeFile(f.file, JSON.stringify({ version: 1, nights, sessions: { 'session-0': { noProgress: 3, attempts: [] } } }));
  await run(options(['--overdue'], {}), f.io);
  const ledger = await f.ledger();
  assert.equal(f.calls(), 1); assert.deepEqual(ledger.nights, nights);
  Object.values(ledger.overdue)[0].attempts[0].outcome = 'interrupted';
  await fs.writeFile(f.file, JSON.stringify(ledger));
  assert.equal((await run(options(['--overdue'], {}), f.io)).rows[0].skip, '同一期限処理済み');
});
