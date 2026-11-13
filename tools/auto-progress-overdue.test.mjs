import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { progressHome } from './test-helpers/auto-progress-home.mjs';
import { run, resumeSession } from './auto-progress-watch.mjs';
import { run as digest } from './auto-progress-digest.mjs';
import { listItems } from './kim-inbox.mjs';
import { executeCheck } from './auto-progress-check.mjs';
import { ledgerFile, readLedger, writeLedger } from './auto-progress-ledger.mjs';
const now = Date.parse('2026-11-05T00:00:00Z');
const output = 'PC-A: gate配布=完了\nPC-B: gate配布=なし\nPC-C: gate配布=完了';
function fixture(t, overrides = {}) {
  const home = progressHome('overdue-fixture-');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.writeFileSync(home + '/.claude.json', JSON.stringify({ oauthAccount: { emailAddress: 'seisaku-team@orgiast.jp' } }));
  const row = { sessionId: '5fd545ff-fixture', owner: 'test-owner@example.com', status: 'open', ts: '2026-10-28T00:00:00Z',
    deadlineAt: '2026-10-30T03:00:00Z', label: '安いAIレーン修復の強制: 03:50監査・7:20日次更新・全PC配布の回収',
    promise: '全PCの安いAIレーンを修復して配布を確認する', check: 'external-check', cwd: home,
    nextClaude: '担当AIがPC-Bの配布を修復して再確認する', ...overrides };
  writeLedger(ledgerFile(home), [row]);
  const messages = [], resumes = [];
  const io = { clock: () => now, transcriptFiles: [], sheetConfig: () => null, digest: async () => ({}),
    escalateKimDecisions: async () => ({}), executeCheck: async () => ({ code: 1, text: output }),
    notifyOwner: async (owner, text) => { messages.push(text); return { delivered: 'inbox' }; },
    resume: async (row, options) => { resumes.push({ row: { ...row }, options }); return { outcome: 'deferred', reason: '実行者なし' }; } };
  return { home, row, messages, resumes, io, read: () => readLedger(ledgerFile(home))[0] };
}
test('check execution preserves every output line', () => {
  assert.equal(executeCheck({ check: 'mock' }, { spawnImpl: () => ({ status: 1, stdout: output }) }).text, output);
});
test('overdue fixture resumes with full output, closes on no executor and reports only once', async t => {
  const f = fixture(t);
  const result = await run({ home: f.home, now, io: f.io });
  assert.deepEqual(result.errors, []);
  assert.equal(f.resumes.length, 1);
  assert.equal(f.resumes[0].options.reason, 'check-overdue');
  assert.equal(f.resumes[0].row.checkText, output);
  assert.equal(f.read().status, 'overdue_reported');
  assert.equal(f.read().resumeCount, 0);
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /最終報告.*期限超過/);
  assert.ok(f.messages[0].includes(f.row.label));
  assert.ok(f.messages[0].includes(f.row.promise));
  assert.match(f.messages[0], /達成 2件 \/ 未達 1件/);
  assert.match(f.messages[0], /次の一手:.*担当AI/);
  await run({ home: f.home, now: now + 25 * 3600000, io: f.io });
  assert.equal(f.resumes.length, 1);
  assert.equal(f.messages.length, 1);
  console.log(JSON.stringify({ fixture: 'ledger-line-1132', transitions: ['open', 'resumed', f.read().status], resume: f.resumes[0].options.reason, report: f.messages[0] }));
});
test('resume success must pass check; progressed without completion closes', async t => {
  for (const completes of [true, false]) {
    const f = fixture(t);
    let checks = 0;
    f.io.executeCheck = async () => ({ code: completes && ++checks > 1 ? 0 : 1, text: output });
    f.io.resume = async () => ({ outcome: 'progressed', reason: '修復を実施' });
    const result = await run({ home: f.home, now, io: f.io });
    assert.deepEqual(result.errors, []);
    assert.equal(f.read().status, completes ? 'done' : 'overdue_reported');
    assert.equal(result.resumed, 1);
  }
});
test('resume limit prevents launching; failed delivery retries only final report', async t => {
  const f = fixture(t, { resumeCount: 8 });
  let checks = 0;
  f.io.executeCheck = async () => { checks++; return { code: 1, text: output }; };
  const notify = f.io.notifyOwner;
  f.io.notifyOwner = async () => ({ delivered: 'none', reason: 'offline' });
  await run({ home: f.home, now, io: f.io });
  assert.equal(f.read().status, 'overdue_reported');
  assert.equal(f.read().overdueReportedAt, undefined);
  f.io.notifyOwner = notify;
  await run({ home: f.home, now, io: f.io });
  await run({ home: f.home, now, io: f.io });
  assert.equal(checks, 1);
  assert.equal(f.resumes.length, 0);
  assert.equal(f.messages.length, 1);
});
test('before deadline notification includes label and counts', async t => {
  const f = fixture(t, { deadlineAt: '2026-11-07T03:00:00Z' });
  await run({ home: f.home, now, io: f.io });
  assert.equal(f.read().status, 'open');
  assert.equal(f.resumes.length, 0);
  const [item] = listItems(f.home);
  assert.ok(item.text.includes(f.row.label));
  assert.match(item.text, /PC-B: gate配布=なし/);
  assert.equal(f.messages.length, 0);
});
test('long promise summary goes through existing digest once per JST day', async t => {
  const f = fixture(t, { deadlineAt: '2026-11-09T03:00:00Z', checkText: output });
  const messages = [];
  const io = { localOwner: f.row.owner, label: 'auto-progress-test-PC', notify: async text => { messages.push(text); return { delivered: 'inbox' }; } };
  await digest({ home: f.home, now, io });
  await digest({ home: f.home, now: now + 3600000, io });
  await digest({ home: f.home, now: now + 9 * 3600000, io });
  assert.equal(messages.filter(s => s.includes('日次進捗')).length, 1);
  await digest({ home: f.home, now: now + 24 * 3600000, io });
  assert.equal(messages.filter(s => s.includes('日次進捗')).length, 2);
  assert.match(messages[0], /達成 2件 \/ 未達 1件/);
});

test('real resume prompt contains complete check evidence', async t => {
  const f = fixture(t);
  let prompt;
  const outcome = await resumeSession({ ...f.row, checkText: output, checkStderr: 'stderr evidence' }, {
    home: f.home, reason: 'check-overdue', io: { executable: 'fake', runChild: async (_, value) => {
      prompt = value;
      return { status: 'failure', skippedNoExecutor: true, executorUsed: 'mock', exitCode: 3 };
    } },
  });
  assert.equal(outcome.deferred, true);
  assert.ok(prompt.includes(output));
  assert.ok(prompt.includes('stderr evidence'));
});
test('overdue check exceptions and old unattended checks reach a final conclusion', async t => {
  const f = fixture(t, { cwd: '/tmp/.stall-sweeper/job' });
  f.io.executeCheck = async () => { throw new Error('check unavailable'); };
  await run({ home: f.home, now, io: f.io });
  assert.equal(f.read().status, 'overdue_reported');
  assert.equal(f.messages.length, 1);
  assert.match(f.messages[0], /check unavailable/);
});
