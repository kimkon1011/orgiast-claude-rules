import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from './auto-progress-digest.mjs';
import { compactDigest } from './lib/owner-dm-digest.mjs';
import { notifyKim } from './notify-kim.mjs';
import { routeOwnerDm } from './lib/owner-dm-policy.mjs';
import { acquireLock } from './lib/progress-file-lock.mjs';

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
 assert.match(kim, /このセッションで回答してください/);
 assert.doesNotMatch(kim, /あなたの操作は不要/);
});

// 2026-11-04 nishi: 夕方のまとめの返事待ちが見出しだけ、本文が「新しいセッションが で引き継ぎ」「10 に成約率」と穴だらけだった。
test('compact digest keeps the question body, slash words, dates and jargon instead of punching holes', () => {
  const deferred = [{ id: 'a1', kind: 'action', at: new Date(now - 1000).toISOString(),
    text: '【kimko-PC（DESKTOP-PPD5V8I）・nishi@orgiast.jp の Claude Code】プロジェクト: nightly-repo ／ セッションの目的: [headless:quota-sweep] x ／ 作業ID: a72f3713\n901 と 902 の前倒し案内を2通送ってよいですか。はい／いいえで返信してください。' }];
  const rows = [{ owner: 'nishi@orgiast.jp', sessionId: 's1', status: 'in_progress', label: '新しいセッションが `/session-start` で引き継ぎを読み、10/28 に成約率を測り直します。回答が届けば autopilot が自動で再開。~/.claude/x.md も見る', ts: new Date(now - 1000).toISOString() }];
  const { text } = compactDigest(rows, deferred, now, { owner: 'nishi@orgiast.jp' });
  assert.match(text, /・901 と 902 の前倒し案内を2通送ってよいですか。はい／いいえで返信してください。（このDMに返信してください）/);
  assert.doesNotMatch(text, /Claude Code】|（）|作業ID|DESKTOP-/);
  const body = compactDigest([{ ...rows[0], nextKim: rows[0].label, status: 'waiting_user' }], [], now, { owner: 'nishi@orgiast.jp' }).text;
  assert.match(body, /\/session-start で引き継ぎ/);
  assert.match(body, /10\/28 に成約率/);
  assert.match(body, /回答が届けば 自動ループ が自動で再開/);
  assert.doesNotMatch(body, /x.md/);
});

test('compact digest keeps the subject of 「自動進行が判断待ちです」 while still stripping the 自動進行: label', () => {
  const deferred = [{ id: 'b1', kind: 'action', at: new Date(now - 1000).toISOString(), text: '自動進行が判断待ちです: 901 の案内を送ってよいですか' },
    { id: 'b2', kind: 'action', at: new Date(now - 2000).toISOString(), text: '自動進行: 902 の案内を送ってよいですか' }];
  const { text } = compactDigest([], deferred, now, { owner: 'nishi@orgiast.jp' });
  assert.match(text, /・自動進行が判断待ちです: 901 の案内を送ってよいですか/);
  assert.match(text, /・902 の案内を送ってよいですか/);
});

// 2026-11-02: 「あなたの判断待ち」が約束側の60字で切れて、何にOKするのかDMだけでは分からなかった。
test('compact digest shows the full decision (up to 400 chars) on its own line', () => {
  const long = '［CLAUDE.md配布］OK の後、データ修正 → パネル作り直し → ファインスティール2月東京の登録 → Codex に頼んでコードを直す。' + 'あ'.repeat(300);
  const { text } = compactDigest([{ owner: 'owner@example.com', sessionId: 's1', status: 'waiting_user',
    label: 'パネル修正と本番反映', promise: 'パネル修正と本番反映', nextKim: long, ts: new Date(now - 1000).toISOString() }], [], now, { owner: 'owner@example.com' });
  const lines = text.split('\n');
  assert.ok(lines.includes('・パネル修正と本番反映（このDMに返信してください）'));
  assert.ok(lines.some(line => line.startsWith('  → 判断してほしいこと: ')), text);
  assert.ok(text.includes('ファインスティール2月東京の登録'), text);
  assert.ok(text.includes('あ'.repeat(300)), 'nextKim が途中で切れていないこと');
  assert.ok(text.split('\n').length <= 12);
});
test('compact digest falls back to reason when nextKim is empty', () => {
  const { text } = compactDigest([{ owner: 'owner@example.com', sessionId: 's1', status: 'waiting_user',
    label: '接続の設定', promise: '接続の設定', nextKim: '', reason: '認証の再実行をお願いします', ts: new Date(now - 1000).toISOString() }], [], now, { owner: 'owner@example.com' });
  assert.match(text, /→ 判断してほしいこと: 認証の再実行をお願いします/);
});

// 2026-10-29 実害: 08:00 開始の1回目のダイジェストが DM 送信で40分以上かかる間に 08:40 の2回目が走り、
// 同じ朝枠（2026-10-29|朝）が2回送信された（sent.jsonl に slot 同一で2件）。ロックを保持した実行が残っている間は送らない。
test('digest 並行実行はロック中なら送らず skipped: locked（10/29 二重送信の再発防止）', async t => {
  const f = fixture(t);
  let calls = 0;
  f.io.notifyOwner = async () => { calls += 1; return { delivered: 'dm', messageId: 'm' }; };
  const release = acquireLock(path.join(f.home, '.claude/state/owner-compact-digest.lock'));
  assert.ok(release, 'lock が取れてテストの前提が成立');
  try {
    assert.deepEqual(await run(f), { sent: false, count: 0, skipped: 'locked' });
  } finally { release(); }
  assert.equal(calls, 0, 'ロック保持中の2回目は DM を送らない');
  // ロック解放後は通常どおり1回だけ送信できる
  assert.equal((await run(f)).sent, true);
  assert.equal(calls, 1);
});

// 2026-11-04 実害: 朝枠で cr@orgiast.jp に同一内容の2通が届いた（parts=2・receipts が同一 owner×2）。
// 同じ宛先は1枠につき1通だけ・本文の先頭は「あなたの返事待ち」でなければならない。
test('digest 同じ宛先には1枠1通だけ送り、本文先頭を返事待ちにする（11/04 複数通の再発防止）', async t => {
  const f = fixture(t);
  const rows = ['a', 'b'].map(sfx => ({ ...row('owner@example.com'), sessionId: `session-${sfx}`, label: `日程の確認${sfx}` }));
  f.io.readLedger = () => rows;
  // digest の pending は owner-dm-deferred.jsonl（kind=action）から読まれる。routeOwnerDm の action は即時経路なので直接シードする。
  const deferred = ['日程8を選んでください', '日程9を選んでください'].map((text, i) => ({ id: `q${i}`, kind: 'action', text, at: new Date(now - 1000 - i).toISOString(), owner: 'owner@example.com' }));
  fs.mkdirSync(path.join(f.home, '.claude/logs'), { recursive: true });
  fs.writeFileSync(path.join(f.home, '.claude/logs/owner-dm-deferred.jsonl'), deferred.map(JSON.stringify).join('\n') + '\n');
  const calls = [];
  f.io.notifyOwner = async (owner, text) => { calls.push({ owner, text }); return { delivered: 'dm', messageId: `m-${calls.length}` }; };
  const result = await run(f);
  assert.equal(result.sent, true);
  assert.equal(result.parts, 1, '同じ宛先へのメッセージは1通だけ');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].owner, 'owner@example.com');
  const lines = calls[0].text.split('\n');
  assert.equal(lines[0], '【進捗まとめ】');
  assert.equal(lines[1], 'あなたの返事待ち', '本文は返事待ち（判断待ち）が先頭');
  const body = calls[0].text;
  assert.ok(body.indexOf('あなたの返事待ち') < body.indexOf('あなたが頼んだこと'), '返事待ちが依頼済み作業より前に来る');
  assert.ok(body.includes('日程8を選んでください'), '待ちの質問が載る');
  assert.ok(body.includes('日程9を選んでください'), '待ちの質問が載る');
  assert.ok(body.includes('日程の確認a') || body.includes('ほか返事待ち'), '台帳の判断待ちが載る');
});
