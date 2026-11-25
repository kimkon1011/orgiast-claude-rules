import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { escalateKimDecisions, escalationRowKey, escalationText, isNoKimAction, sweepStaleEscalations } from './auto-progress-escalate.mjs';
import { ledgerFile, writeLedger } from './auto-progress-ledger.mjs';
import { addItem, readInboxItem, updateInboxItem } from './kim-inbox.mjs';
import { escalationDedupeKey } from './lib/escalation-answer-sync.mjs';
const H = 3600000;
const now = Date.parse('2026-11-04T10:00:00Z');
const row = (hours, extra = {}) => ({ ts: new Date(now - hours * H).toISOString(), sessionId: `session-${hours}`, status: 'waiting_user', nextKim: 'kim の承認が必要です', promise: '返信を確認して報告', pc: 'test-PC', ...extra });
function setup(t, rows) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'escalate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, now, io: { readLedger: () => rows, notifyKim: async () => ({ delivered: 'dm' }) } };
}
test('48h boundary, older timestamp, statuses and owner filtering', async t => {
  const opts = setup(t, [row(47.99), row(48), row(49, { status: 'done' }), row(50, { nextKim: '設定を保存' }), row(1, { lastCheckedAt: new Date(now - 50 * H).toISOString() }), row(60, { lastCheckedAt: new Date(now).toISOString() }), row(1, { ts: 'invalid' })]);
  const result = await escalateKimDecisions({ ...opts, dryRun: true });
  assert.equal(result.targets.length, 3);
  assert.equal(result.sent, 0);
  assert.equal(fs.existsSync(path.join(opts.home, '.claude')), false);
});
test('successful delivery persists dedup and allows retry at 24h', async t => {
  const r = row(60), opts = setup(t, [r]);
  let calls = 0;
  opts.io.notifyKim = async (text, options) => { calls++; assert.equal(options.kind, 'ask'); assert.equal(options.kimActionRequired, true); assert.equal(options.sessionId, r.sessionId); return { delivered: 'dm' }; };
  assert.equal((await escalateKimDecisions(opts)).sent, 1);
  const state = JSON.parse(fs.readFileSync(path.join(opts.home, '.claude/auto-progress-escalated.json')));
  assert.equal(state[escalationRowKey(r)], new Date(now).toISOString());
  assert.equal((await escalateKimDecisions({ ...opts, now: now + 24 * H - 1 })).targets.length, 0);
  assert.equal((await escalateKimDecisions({ ...opts, now: now + 24 * H })).sent, 1);
  assert.equal(calls, 2);
});
test('blocked and throwing deliveries continue without recording success', async t => {
  const rows = [row(60), row(61), row(62)], opts = setup(t, rows), errors = [];
  let calls = 0;
  opts.io.stderr = text => errors.push(text);
  opts.io.notifyKim = async () => { calls++; if (calls === 1) return { delivered: 'blocked', reason: 'policy' }; if (calls === 2) throw new Error('offline'); return { delivered: 'dm' }; };
  assert.equal((await escalateKimDecisions(opts)).sent, 1);
  assert.equal(calls, 3);
  assert.match(errors[0], /blocked/);
  assert.match(errors[1], /offline/);
  const state = JSON.parse(fs.readFileSync(path.join(opts.home, '.claude/auto-progress-escalated.json')));
  assert.deepEqual(Object.keys(state), [escalationRowKey(rows[2])]);
});
test('isNoKimAction: 空・なし系は真', () => {
  assert.ok(isNoKimAction(''));
  assert.ok(isNoKimAction('なし'));
  assert.ok(isNoKimAction('無し'));
  assert.ok(isNoKimAction('特になし'));
  assert.ok(isNoKimAction('不要'));
  assert.ok(isNoKimAction('対応不要'));
  assert.ok(isNoKimAction('　なし　'));
});
test('isNoKimAction: 補足付きなしは真（括弧・句読点・ダッシュ・空白）', () => {
  assert.ok(isNoKimAction('なし（kim-PC の電源を入れたままにしておけば自動で進む）'));
  assert.ok(isNoKimAction('不要。自動で進む'));
  assert.ok(isNoKimAction('なし - 自動'));
  assert.ok(isNoKimAction('なし: 自動'));
  assert.ok(isNoKimAction('なし、自動'));
  assert.ok(isNoKimAction('なし（補足）'));
  assert.ok(isNoKimAction('無し（補足）'));
  assert.ok(isNoKimAction('なし【補足】'));
  assert.ok(isNoKimAction('なし[補足]'));
  assert.ok(isNoKimAction('特になし（自動）'));
  assert.ok(isNoKimAction('不要（自動）'));
  assert.ok(isNoKimAction('対応不要（自動）'));
  assert.ok(isNoKimAction('なし。'));
  assert.ok(isNoKimAction('なし,自動'));
  assert.ok(isNoKimAction('不要：自動'));
  assert.ok(isNoKimAction('無し—'));
  assert.ok(isNoKimAction('なしー'));
});
test('isNoKimAction: なしで始まっても文意が続くのは偽', () => {
  assert.ok(!isNoKimAction('なしで進めてよいか判断してください'));
  assert.ok(!isNoKimAction('無しにするか決めてください'));
  assert.ok(!isNoKimAction('不要な下書きを削除してよいか'));
  assert.ok(!isNoKimAction('対応不要とするか決めて'));
});
test('escalateKimDecisions: 補足付き「なし（…）」行はエスカレーション対象外', async t => {
  const opts = setup(t, [
    { ...row(60), nextKim: 'なし（kim-PC の電源を入れたままにしておけば自動で進む）' },
    { ...row(61), nextKim: 'kim の承認が必要' },
  ]);
  const result = await escalateKimDecisions({ ...opts, dryRun: true });
  assert.equal(result.targets.length, 1);
  assert.ok(result.targets[0].text.includes('kim の承認が必要'));
});
test('dry-run never sends or modifies existing state', async t => {
  const opts = setup(t, [row(60)]);
  opts.io.notifyKim = () => assert.fail('dry-run must not send');
  fs.mkdirSync(path.join(opts.home, '.claude'));
  const file = path.join(opts.home, '.claude/auto-progress-escalated.json');
  fs.writeFileSync(file, '{}\n');
  assert.equal((await escalateKimDecisions({ ...opts, dryRun: true })).targets.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), '{}\n');
  assert.equal(fs.existsSync(file + '.lock'), false);
});
test('nextKim が空または なし の行は owner が kim でも escalate 対象外', async t => {
  const opts = setup(t, [
    { ...row(60), owner: 'kim-PC', nextKim: '' },
    { ...row(61), owner: 'kim-PC', nextKim: 'なし' },
    { ...row(62), owner: 'kim-PC', nextKim: '　なし　' },
    { ...row(63), owner: 'kim-PC', nextKim: 'kim の承認が必要' },
  ]);
  const result = await escalateKimDecisions({ ...opts, dryRun: true });
  assert.equal(result.targets.length, 1);
  assert.ok(result.targets[0].text.includes('kim の承認が必要'));
});
test('message preserves decision text and caps context lengths', () => {
  const text = escalationText(row(60, { nextKim: 'あ'.repeat(2001), promise: '約'.repeat(201) }), now);
  assert.match(text, /判断待ち 2日/);
  assert.ok(text.includes('あ'.repeat(2000)));
  assert.ok(!text.includes('あ'.repeat(2001)));
  assert.ok(text.includes('約'.repeat(200)));
  assert.ok(!text.includes('約'.repeat(201)));
  assert.match(text, /PC test-PC \/ セッション session- \/ 台帳 ts/);
});

test('同じ行の ask が受信箱にあれば新しく積まず、回答済みなら台帳へ書き戻す（2026-11-19 重複質問）', async t => {
  const open = row(60), answered = row(70, { sessionId: 'abcdef12-0000' }), fresh = row(80);
  const opts = setup(t, [open, answered, fresh]);
  const ask = (r, extra) => ({ id: 'ki-x', kind: 'ask', text: escalationText(r, now - 24 * H), ...extra });
  const synced = [], sentOptions = [];
  opts.io.listInbox = () => [ask(open, { status: 'open' }), ask(answered, { status: 'answered', answer: '既製品ですすめて', answeredAt: new Date(now - H).toISOString() })];
  opts.io.syncAnswer = (home, item) => { synced.push(item.answer); return true; };
  opts.io.notifyKim = async (text, options) => { sentOptions.push(options); return { delivered: 'session-inbox' }; };
  const result = await escalateKimDecisions(opts);
  assert.equal(result.sent, 1);
  assert.deepEqual(result.targets.map(target => target.rowKey), [escalationRowKey(fresh)]);
  assert.deepEqual(result.suppressed.map(entry => entry.reason).sort(), ['already-open', 'answered']);
  assert.deepEqual(synced, ['既製品ですすめて']);
  assert.equal(sentOptions[0].dedupeKey, `auto-progress-escalate:${escalationRowKey(fresh)}`);
  assert.equal(sentOptions[0].source, 'auto-progress-escalate');
});

test('message includes ask and nextClaude with capped lengths', () => {
  const text = escalationText(row(60, { ask: '問'.repeat(201), nextClaude: '次'.repeat(151) }), now);
  assert.ok(text.includes(`（ask: ${'問'.repeat(200)}）`));
  assert.ok(text.includes(`（次の手: ${'次'.repeat(150)}）`));
  assert.doesNotMatch(escalationText(row(60), now), /（ask:|（次の手:/);
});

async function setupSweep(t, status, { age = 120 * H, legacy = false } = {}) {
  const r = row(144, { status });
  const { home } = setup(t, []);
  writeLedger(ledgerFile(home), status ? [r] : []);
  const key = escalationRowKey(r);
  const file = path.join(home, '.claude', 'auto-progress-escalated.json');
  const state = { [key]: r.ts, unrelated: r.ts };
  fs.writeFileSync(file, JSON.stringify(state));
  const inboxOptions = { kind: 'ask', source: 'auto-progress-escalate', text: escalationText(r, now),
    ...(legacy ? {} : { sessionId: r.sessionId, dedupeKey: escalationDedupeKey(key) }) };
  const item = await addItem(home, inboxOptions, { drain: false, localOnly: true });
  updateInboxItem(home, item.id, current => { current.createdAt = new Date(now - age).toISOString(); });
  return { home, r, item, file, state, inboxOptions, opts: { home, now } };
}

test('sweepStaleEscalations: 5日未満の ask は取り下げない', async t => {
  const { opts, home, item } = await setupSweep(t, 'done', { age: 120 * H - 1 });
  assert.deepEqual(sweepStaleEscalations(opts).dropped, []);
  assert.equal(readInboxItem(home, item.id).status, 'open');
});

test('sweepStaleEscalations: 5日以上経過した終了行の ask を取り下げ、再送できる', async t => {
  for (const status of ['done', 'expired', 'superseded', 'skipped']) {
    const { opts, home, r, item, file, state, inboxOptions } = await setupSweep(t, status);
    const { dropped } = sweepStaleEscalations(opts);
    assert.deepEqual(dropped.map(entry => [entry.id, entry.rowStatus]), [[item.id, status]]);
    assert.equal(readInboxItem(home, item.id).status, 'dropped');
    assert.deepEqual(JSON.parse(fs.readFileSync(file)), { unrelated: state.unrelated });
    assert.deepEqual(sweepStaleEscalations(opts).dropped, []);
    writeLedger(ledgerFile(home), [{ ...r, status: 'waiting_user' }]);
    const result = await escalateKimDecisions({ ...opts, io: { notifyKim: async () => {
      const resent = await addItem(home, inboxOptions, { drain: false, localOnly: true });
      assert.notEqual(resent.id, item.id);
      assert.equal(resent.status, 'open');
      return { delivered: 'session-inbox' };
    } } });
    assert.equal(result.sent, 1);
  }
});

test('sweepStaleEscalations: 元の行が見つからない旧形式 ask を取り下げる', async t => {
  const { opts, home, item, file, state } = await setupSweep(t, undefined, { legacy: true });
  assert.equal(sweepStaleEscalations(opts).dropped[0].rowStatus, 'missing');
  assert.equal(readInboxItem(home, item.id).status, 'dropped');
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), { unrelated: state.unrelated });
});

test('sweepStaleEscalations: dry-run は状態を変更しない', async t => {
  const { opts, home, item, file, state } = await setupSweep(t, 'done');
  assert.equal(sweepStaleEscalations({ ...opts, dryRun: true }).dropped[0].id, item.id);
  assert.equal(readInboxItem(home, item.id).status, 'open');
  assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(state));
  assert.equal(fs.existsSync(file + '.lock'), false);
});

test('sweepStaleEscalations: 継続中の行はスキップする', async t => {
  for (const status of ['open', 'waiting_user', 'stalled', 'overdue']) {
    const { opts, home, item } = await setupSweep(t, status);
    assert.deepEqual(sweepStaleEscalations(opts).dropped, []);
    assert.equal(readInboxItem(home, item.id).status, 'open');
  }
});
