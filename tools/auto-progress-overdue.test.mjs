import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { progressHome } from './test-helpers/auto-progress-home.mjs';
import { run, resumeSession, MAX_RESUMES, PROGRESS_INTERVAL_MS, migrateLegacyAddChecks } from './auto-progress-watch.mjs';
import { run as digest } from './auto-progress-digest.mjs';
import { executeCheck, resolveCheckTimeout } from './auto-progress-check.mjs';
import { ledgerFile, readLedger, writeLedger, latestOpenPromises, applyPromise } from './auto-progress-ledger.mjs';
import { addCheck } from './auto-progress.mjs';
import { listItems, compactItems, markSeen, selectContext } from './kim-inbox.mjs';
import { collectAwaiting, respond, apId } from './kim-awaiting.mjs';
const now = Date.parse('2026-11-05T00:00:00Z');
const H = 3600000;
const output = 'PC-A: gate配布=完了\nPC-B: gate配布=なし\nPC-C: gate配布=完了';
function fixture(t, overrides = {}) {
  const home = progressHome('overdue-fixture-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'kim@orgiast.jp' } }));
  const row = { sessionId: '5fd545ff-fixture', owner: 'kim@orgiast.jp', status: 'open', ts: '2026-10-28T00:00:00Z',
    deadlineAt: '2026-10-30T03:00:00Z', label: '全PC配布の回収', nextKim: 'なし',
    promise: '全PCの安いAIレーンを修復して配布を確認する', check: 'external-check', cwd: home,
    nextClaude: 'PC-Bの配布を修復して再確認する', ...overrides };
  writeLedger(ledgerFile(home), [row]);
  const messages = [], resumes = [];
  const io = { clock: () => now, transcriptFiles: [], sheetConfig: () => null, digest: async () => ({}),
    escalateKimDecisions: async () => ({}), executeCheck: async () => ({ code: 1, text: output }),
    notifyOwner: async (owner, text) => { messages.push(text); return { delivered: 'inbox' }; },
    resume: async (row, options) => { resumes.push({ row: { ...row }, options }); return { outcome: 'deferred', reason: '実行者なし' }; } };
  return { home, row, messages, resumes, io, read: () => readLedger(ledgerFile(home)).at(-1) };
}
test('check execution preserves every output line', () => {
  assert.equal(executeCheck({ check: 'mock' }, { spawnImpl: () => ({ status: 1, stdout: output }) }).text, output);
});
test('overdue without executor remains open, retries next cycle, and reports periodically', async t => {
  const f = fixture(t);
  const result = await run({ home: f.home, now, io: f.io });
  assert.deepEqual(result.errors, []);
  assert.equal(f.resumes[0].options.reason, 'check-overdue');
  assert.equal(f.resumes[0].row.checkText, output);
  assert.equal(f.read().status, 'overdue');
  assert.equal(f.read().resumeCount, 0);
  assert.equal(latestOpenPromises(readLedger(ledgerFile(f.home))).length, 1);
  const info = listItems(f.home)[0];
  assert.match(info.text, /期限超過・追跡中/);
  assert.ok(info.text.includes(output));
  assert.match(info.text, /Claude の次の手: PC-B/);
  await run({ home: f.home, now: now + 25 * H, io: f.io });
  assert.equal(f.resumes.length, 2);
  assert.equal(listItems(f.home).length, 1);
  assert.equal(listItems(f.home)[0].repeatCount, 2);
});
for (const mode of ['budget', 'interval', 'cwd', 'per-run-limit']) test(`temporary ${mode} resumes on a later cycle`, async t => {
  const f = fixture(t, mode === 'interval' ? { resumedAt: new Date(now - H).toISOString() } : {});
  let checks = 0;
  f.io.executeCheck = async () => { checks++; return { code: 1, text: output }; };
  if (mode === 'budget') { let ticks = 0; f.io.clock = () => now + (ticks++ ? 24 * 60000 : 0); }
  if (mode === 'cwd') f.io.cwdExists = () => false;
  if (mode === 'per-run-limit') {
    writeLedger(ledgerFile(f.home), [...Array.from({ length: 4 }, (_, i) => ({ ...f.row, sessionId: `prior-${i}`, label: `prior-${i}` })), f.row]);
    f.io.resume = async (row, options) => { f.resumes.push({ row, options }); return { outcome: 'progressed', reason: '続行中' }; };
  }
  await run({ home: f.home, now, io: f.io });
  assert.equal(f.read().status, 'overdue');
  assert.equal(f.resumes.filter(r => r.row.sessionId === f.row.sessionId).length, 0);
  const firstChecks = checks;
  f.io.clock = () => now + 3 * H; f.io.cwdExists = () => true;
  // Earlier jobs are still within their resume interval at this cycle; isolate this row for the per-run cap case.
  if (mode === 'per-run-limit') writeLedger(ledgerFile(f.home), [f.read()]);
  await run({ home: f.home, now: now + 3 * H, io: f.io });
  assert.ok(checks > firstChecks);
  assert.equal(f.resumes.filter(r => r.row.sessionId === f.row.sessionId).length, 1);
});
test('resume success must pass check; progressed without completion stays overdue', async t => {
  for (const completes of [true, false]) {
    const f = fixture(t); let checks = 0;
    f.io.executeCheck = async () => ({ code: completes && ++checks > 1 ? 0 : 1, text: output });
    f.io.resume = async () => ({ outcome: 'progressed', reason: '修復を実施' });
    const result = await run({ home: f.home, now, io: f.io });
    assert.deepEqual(result.errors, []);
    assert.equal(f.read().status, completes ? 'done' : 'overdue');
    assert.equal(result.resumed, 1);
  }
});
for (const initialCount of [MAX_RESUMES - 1, MAX_RESUMES]) test(`resume limit ${initialCount} becomes stalled and remains in kim-awaiting until skip`, async t => {
  const f = fixture(t, { resumeCount: initialCount }); let checks = 0, resumes = 0;
  f.io.executeCheck = async () => { checks++; return { code: 1, text: output }; };
  f.io.resume = async () => { resumes++; return { outcome: 'error', reason: '失敗' }; };
  await run({ home: f.home, now, io: f.io });
  assert.equal(f.read().status, 'stalled');
  assert.equal(f.read().resumeCount, MAX_RESUMES);
  const waiting = collectAwaiting({ home: f.home, now });
  assert.equal(waiting.length, 1); assert.match(waiting[0].progress, /止まっている/);
  await run({ home: f.home, now: now + H, io: f.io });
  assert.ok(checks >= 2); assert.equal(resumes, initialCount < MAX_RESUMES ? 1 : 0);
  respond(apId(f.read()), { home: f.home, now, skip: true, reason: '不要' });
  await run({ home: f.home, now: now + 2 * H, io: f.io });
  assert.equal(collectAwaiting({ home: f.home, now }).length, 0);
  assert.equal(latestOpenPromises(readLedger(ledgerFile(f.home))).length, 0);
});
test('unchanged progress every three hours is one reusable info, idempotent and compact compatible', async t => {
  const f = fixture(t, { ts: new Date(now).toISOString(), deadlineAt: new Date(now + 24 * H).toISOString() });
  for (const offset of [0, PROGRESS_INTERVAL_MS - 1]) await run({ home: f.home, now: now + offset, io: f.io });
  assert.equal(listItems(f.home).length, 0);
  await run({ home: f.home, now: now + PROGRESS_INTERVAL_MS, io: f.io });
  let item = listItems(f.home)[0]; assert.equal(item.repeatCount, 1);
  const asks = Array.from({ length: 5 }, (_, i) => ({ kind: 'ask', status: 'open', id: `ask-${i}`, text: `質問${i}`, createdAt: f.row.ts, shownSessions: [], shownCount: 0 }));
  const context = selectContext([...asks, item], { sessionId: 'another-session', now });
  assert.ok(context.indexOf('自動進行の進捗') < context.indexOf('質問0'));
  markSeen(f.home, item.id);
  await run({ home: f.home, now: now + PROGRESS_INTERVAL_MS * 2, io: f.io });
  item = listItems(f.home)[0];
  assert.equal(item.status, 'open'); assert.equal(item.repeatCount, 2); assert.equal(item.shownCount, 0);
  assert.deepEqual(item.shownSessions, []);
  await run({ home: f.home, now: now + PROGRESS_INTERVAL_MS * 2, io: f.io });
  // Simulate a crash after inbox publication but before advancing the ledger clock.
  writeLedger(ledgerFile(f.home), [{ ...f.read(), lastProgressNotifiedAt: new Date(now + PROGRESS_INTERVAL_MS).toISOString() }]);
  await run({ home: f.home, now: now + PROGRESS_INTERVAL_MS * 2, io: f.io });
  assert.equal(listItems(f.home)[0].repeatCount, 2);
  compactItems(f.home); assert.equal(listItems(f.home).length, 1);
  const other = { ...f.read(), sessionId: 'other-job', label: f.row.label };
  writeLedger(ledgerFile(f.home), [f.read(), { ...other, lastProgressNotifiedAt: new Date(now).toISOString() }]);
  await run({ home: f.home, now: now + PROGRESS_INTERVAL_MS * 2, io: f.io });
  compactItems(f.home); assert.equal(listItems(f.home).length, 2);
});
test('periodic delivery failure retains the due clock and retries', async t => {
  const f = fixture(t);
  f.io.addProgressInboxItem = async () => { throw Error('disk full'); };
  const result = await run({ home: f.home, now, io: f.io });
  assert.ok(result.errors.some(e => /disk full/.test(e))); assert.equal(f.read().lastProgressNotifiedAt, undefined);
  delete f.io.addProgressInboxItem;
  await run({ home: f.home, now, io: f.io });
  assert.equal(f.read().lastProgressNotifiedAt, new Date(now).toISOString());
});
test('morning and evening digest always include unchanged Claude checks with state', async t => {
  const f = fixture(t, { status: 'overdue', checkText: output }); const messages = [];
  const io = { localOwner: 'kim@orgiast.jp', label: 'kim-PC', readDeadlineDigest: async () => '', fetchCaseResume: async () => null,
    notify: async text => { messages.push(text); return { delivered: 'inbox' }; } };
  await digest({ home: f.home, now, slot: '朝', io });
  await digest({ home: f.home, now: now + 9 * H, slot: '夕', io });
  assert.equal(messages.length, 2);
  for (const text of messages) { assert.ok(text.includes(f.row.label)); assert.match(text, /期限超過・追跡中/); assert.match(text, /達成 2件 \/ 未達 1件/); }
});
test('auto session check is open with nextClaude, at least six hours and 120 seconds, rolling only on activity', async t => {
  const f = fixture(t); const check = 'node "session-progress-check.mjs" --session "session"';
  const row = addCheck({ home: f.home, now, session: 'session', cwd: f.home, check, nextClaude: '続きを実行する', deadline: '+1h', label: '自動登録', autoRegisteredCheck: true });
  assert.equal(row.status, 'open'); assert.equal(row.startWhen, undefined); assert.equal(row.nextClaude, '続きを実行する');
  assert.ok(Date.parse(row.deadlineAt) >= now + 6 * H); assert.equal(row.checkTimeoutMs, 120000);
  assert.equal(resolveCheckTimeout({ check }), 120000);
  const updated = applyPromise([row], { sessionId: row.sessionId, ts: new Date(now + 4 * H).toISOString(), promise: '作業を継続', status: 'open' }).at(-1);
  assert.equal(Date.parse(updated.deadlineAt), now + 10 * H);
  writeLedger(ledgerFile(f.home), [row]);
  f.io.transcriptEvidence = () => ({ lastAt: now + 5 * H });
  await run({ home: f.home, now: now + 5 * H, io: f.io });
  assert.equal(Date.parse(f.read().deadlineAt), now + 11 * H);
  await run({ home: f.home, now: now + 6 * H, io: f.io });
  assert.equal(Date.parse(f.read().deadlineAt), now + 11 * H);
});
test('timeout is unknown, never closes or spends a resume, and next check can finish', async t => {
  const f = fixture(t);
  f.io.executeCheck = () => executeCheck(f.row, { spawnImpl: () => ({ error: { code: 'ETIMEDOUT' }, stdout: '途中の出力' }) });
  await run({ home: f.home, now, io: f.io });
  assert.equal(f.read().status, 'overdue'); assert.equal(f.read().checkResult, 'unknown');
  assert.match(f.read().checkText, /判定不能/); assert.equal(f.resumes.length, 0);
  f.io.executeCheck = () => ({ code: 0, text: '完了を確認' });
  await run({ home: f.home, now: now + H, io: f.io });
  assert.equal(f.read().status, 'done');
});
test('converted scheduled rows migrate to completion checks without starting new work', async t => {
  const f = fixture(t, { check: undefined, startWhen: 'external-check', status: 'scheduled', convertedFromAddCheck: true, deadlineAt: new Date(now + H).toISOString() });
  assert.equal((await migrateLegacyAddChecks({ home: f.home, now })).restored, 1);
  assert.equal((await migrateLegacyAddChecks({ home: f.home, now })).targets.length, 0);
  assert.equal(f.read().check, 'external-check'); assert.equal(f.read().startWhen, undefined);
  assert.equal(f.read().nextClaude, f.row.nextClaude);
  await run({ home: f.home, now, io: f.io });
  assert.equal(f.read().status, 'open'); assert.equal(f.read().checkResult, 'unmet');
  assert.equal(f.resumes.length, 0);
});
test('old overdue_reported rows are recovered and checked again', async t => {
  const f = fixture(t, { status: 'overdue_reported', overdueReportedAt: new Date(now - H).toISOString() });
  await run({ home: f.home, now, io: f.io });
  assert.equal(f.read().status, 'overdue'); assert.equal(f.resumes.length, 1);
});
test('real resume prompt contains complete check evidence', async t => {
  const f = fixture(t); let prompt;
  const outcome = await resumeSession({ ...f.row, checkText: output, checkStderr: 'stderr evidence' }, {
    home: f.home, reason: 'check-overdue', io: { executable: 'fake', runChild: async (_, value) => {
      prompt = value; return { status: 'failure', skippedNoExecutor: true, executorUsed: 'mock', exitCode: 3 };
    } },
  });
  assert.equal(outcome.deferred, true); assert.ok(prompt.includes(output)); assert.ok(prompt.includes('stderr evidence'));
});
test('check exceptions and old unattended checks remain tracked', async t => {
  const f = fixture(t, { cwd: '/tmp/.stall-sweeper/job' });
  f.io.executeCheck = async () => { throw new Error('check unavailable'); };
  await run({ home: f.home, now, io: f.io });
  assert.equal(f.read().status, 'overdue'); assert.match(f.read().checkText, /check unavailable/);
});

test('an explicit answer to a stalled check enables a fresh bounded retry', async t => {
  const f = fixture(t, { status: 'stalled', resumeCount: MAX_RESUMES });
  const answerFile = path.join(f.home, 'answer.txt'); fs.writeFileSync(answerFile, '再開してください');
  respond(apId(f.read()), { home: f.home, now, bodyFile: answerFile });
  assert.equal(f.read().resumeCount, 0); assert.equal(f.read().resumeCountBeforeAnswer, MAX_RESUMES);
  await run({ home: f.home, now, io: f.io });
  assert.equal(f.resumes.length, 1);
});
test('recovery never revives a task superseded by a completed check', async t => {
  const f = fixture(t, { status: 'overdue_reported' });
  writeLedger(ledgerFile(f.home), [f.row, { ...f.row, ts: new Date(now).toISOString(), status: 'done', doneNotifiedAt: new Date(now).toISOString() }]);
  f.io.executeCheck = () => assert.fail('completed task must stay closed');
  await run({ home: f.home, now, io: f.io });
  assert.equal(latestOpenPromises(readLedger(ledgerFile(f.home))).length, 0);
});
test('long check output retains work ID and priority even when deadlines are present', async t => {
  const f = fixture(t);
  f.io.executeCheck = () => ({ code: 1, text: output.repeat(500) });
  await run({ home: f.home, now, io: f.io });
  const info = listItems(f.home)[0]; assert.match(info.text, /作業ID: 5fd545ff/);
  const base = { status: 'open', createdAt: f.row.ts, shownSessions: [], shownCount: 0 };
  const items = [{ ...base, kind: 'deadline', key: 'D-001', due: '2026-11-06', text: '期限の確認' },
    ...Array.from({ length: 5 }, (_, i) => ({ ...base, kind: 'ask', id: `ask-${i}`, text: `質問${i}` })), info];
  const context = selectContext(items, { sessionId: '5fd545ff-another', now });
  assert.ok(context.includes('自動進行の進捗'));
  if (context.includes('質問0')) assert.ok(context.indexOf('自動進行の進捗') < context.indexOf('質問0'));
});
