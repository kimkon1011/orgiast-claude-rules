import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './auto-progress-digest.mjs';
import { compactDigest } from './lib/owner-dm-digest.mjs';
import { notifyKim } from './notify-kim.mjs';
import { routeOwnerDm } from './lib/owner-dm-policy.mjs';

const now = Date.parse('2026-11-04T00:00:00Z');
const row = owner => ({ owner, sessionId: `session-${owner}`, status: 'waiting_user', label: '日程の確認', promise: '日程を確認する', nextKim: '5日か6日を選んでください', ts: new Date(now - 1000).toISOString() });
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dm-digest-regression-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, now, io: { localOwner: 'owner@example.com', label: 'other-PC', readLedger: () => [row('owner@example.com')] } };
}
const sentLog = home => fs.readFileSync(path.join(home, '.claude/logs/auto-progress-digest.sent.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);

test('digest preserves messageId recipientId httpStatus and failed receipts, retrying the same slot', async t => {
  const f = fixture(t);
  let calls = 0;
  f.io.notifyOwner = async (owner, text, options) => {
    assert.equal(owner, 'owner@example.com');
    assert.equal(options.webhookFallback, false);
    assert.equal(options.kind, 'digest');
    assert.ok(text.split('\n').length <= 10);
    return ++calls === 1 ? { delivered: 'none', httpStatus: 503, reason: 'offline' } : { delivered: 'dm', messageId: 'message-1', recipientId: 'recipient-1', httpStatus: 200 };
  };
  assert.equal((await run(f)).sent, false);
  assert.equal(fs.existsSync(path.join(f.home, '.claude/state/auto-progress-digest.json')), false);
  assert.equal((await run(f)).sent, true);
  const logs = sentLog(f.home);
  assert.equal(logs[0].sent, false);
  assert.equal(logs[0].receipts[0].httpStatus, 503);
  assert.deepEqual([logs[1].receipts[0].messageId, logs[1].receipts[0].recipientId, logs[1].receipts[0].httpStatus], ['message-1', 'recipient-1', 200]);
  assert.equal((await run(f)).skipped, 'already-sent');
  assert.equal(calls, 2);
});

test('digest dry-run leaves even directories absent, including deferred consumption and delivery state', async t => {
  const f = fixture(t);
  f.io.notifyOwner = () => assert.fail('dry-run must not send');
  assert.ok((await run({ ...f, dryRun: true })).text);
  assert.deepEqual(fs.readdirSync(f.home), []);
});

test('digest retries only failed owners and keeps each private question with its owner', async t => {
  const f = fixture(t), calls = [];
  f.io.readLedger = () => ['a', 'b'].map(owner => ({ ...row(owner), nextKim: `${owner}の質問へ返信してください` }));
  f.io.notifyOwner = async (owner, text) => {
    assert.ok(text.includes(`${owner}の質問`));
    assert.ok(!text.includes(`${owner === 'a' ? 'b' : 'a'}の質問`));
    calls.push(owner);
    return calls.length === 2 ? { delivered: 'none' } : { delivered: 'dm', messageId: `m-${calls.length}` };
  };
  assert.equal((await run(f)).sent, false);
  assert.equal((await run(f)).sent, true);
  assert.deepEqual(calls, ['a', 'b', 'b']);
});

test('digest keeps capped actions unconsumed on failure and consumes them only after delivery', async t => {
  const f = fixture(t);
  f.io.readLedger = () => [];
  for (let n = 0; n < 9; n++) await routeOwnerDm('owner@example.com', `日程${n}を選んでください`, { home: f.home, now, kind: 'action' });
  let fail = true;
  f.io.notifyOwner = async (_, text) => {
    assert.ok(text.includes('日程8を選んでください'));
    return { delivered: fail ? 'none' : 'dm', messageId: fail ? undefined : 'receipt' };
  };
  assert.equal((await run(f)).sent, false);
  fail = false;
  assert.equal((await run(f)).sent, true);
  const state = JSON.parse(fs.readFileSync(path.join(f.home, '.claude/state/auto-progress-digest.json'), 'utf8'));
  assert.equal(state.deferredConsumed.length, 1);
  assert.equal((await run({ ...f, now: now + 9 * 3600000 })).sent, false);
});

test('digest excludes unattended names using the supplied home and fits stale plus overflow questions in ten lines', t => {
  const f = fixture(t);
  const deferred = Array.from({ length: 5 }, (_, i) => ({ id: `q${i}`, kind: 'action', text: `質問${i}`, at: new Date(now - (i === 4 ? 8 * 86400000 : 0)).toISOString() }));
  const out = compactDigest([{ ...row('owner@example.com'), status: 'done', cwd: path.join(f.home, '.claude/scratch/task'), promise: '表示しない内部目的' }], deferred, now, { home: f.home });
  assert.ok(`【進捗まとめ】\n${out.text}`.split('\n').length <= 10);
  assert.match(out.text, /古い待ち 1件/);
  assert.match(out.text, /ほか返事待ち 2件/);
  assert.match(out.text, /自動作業\n完了 1件/);
  assert.doesNotMatch(out.text, /表示しない内部目的/);
});

test('compact digest containing a failure title never creates another repair task', async t => {
  const f = fixture(t);
  const result = await notifyKim('【進捗まとめ】\nあなたが頼んだこと\n完了 1件: 接続失敗の修正', {
    home: f.home, now, kind: 'digest', plainJa: false, userId: 'test-recipient', token: 'test-token', webhookFallback: false,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ id: 'receipt' }) }),
  });
  assert.equal(result.delivered, 'dm');
  assert.equal(fs.existsSync(path.join(f.home, '.claude/next-session.md')), false);
});

test('compact digest identifies kim decisions and retains waiting rows without nextKim', t => {
 const f = fixture(t);
 const rows = [
   { ...row('owner@example.com'), reason: 'kim の判断', promise: '契約の確認' },
   { ...row('owner@example.com'), nextKim: '', promise: '日付の確認' },
 ];
 const out = compactDigest(rows, [], now, { home: f.home, owner: 'owner@example.com' }).text;
 assert.match(out, /kim の判断待ち: .*（あなたの操作は不要）/);
 assert.match(out, /日程の確認（このDMに返信してください）/);
 assert.ok(`【進捗まとめ】\n${out}`.split('\n').length <= 10);
 const kim = compactDigest([rows[0]], [], now, { home: f.home, owner: 'kim@orgiast.jp' }).text;
 assert.match(kim, /このDMに返信してください/);
 assert.doesNotMatch(kim, /あなたの操作は不要/);
});
