import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FINAL_ONLY_INSTRUCTION, selectNew, markShown, isLoopWake, recordPrompt } from './inbox-display-policy.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'inbox-policy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('FINAL_ONLY_INSTRUCTION に「応答の冒頭」が含まれず、正しい文言が入っている', () => {
  assert.doesNotMatch(FINAL_ONLY_INSTRUCTION, /応答の冒頭/);
  assert.match(FINAL_ONLY_INSTRUCTION, /【表示ルール】/);
  assert.match(FINAL_ONLY_INSTRUCTION, /最後のメッセージ/);
  assert.match(FINAL_ONLY_INSTRUCTION, /再掲しない/);
});

test('同一セッションで2回目のプロンプト（id 1件追加）→ 追加された1件だけ全文、残りは件数行', t => {
  const home = fixture(t);
  const sessionId = 's1';
  const now = Date.now();
  // 1回目: 2件表示
  const ids1 = ['id-a', 'id-b'];
  const r1 = selectNew({ home, hook: 'test-hook', sessionId, ids: ids1, now });
  assert.equal(r1.fresh.length, 2);
  assert.equal(r1.known, 0);
  markShown({ home, hook: 'test-hook', sessionId, ids: ids1, now });
  // 2回目: id-c が新規追加、id-a と id-b は既出
  const ids2 = ['id-a', 'id-b', 'id-c'];
  const r2 = selectNew({ home, hook: 'test-hook', sessionId, ids: ids2, now: now + 60_000 });
  assert.deepEqual(r2.fresh, ['id-c']);
  assert.equal(r2.known, 2);
});

test('別セッション（24h以内に表示済み）→ 件数行のみ。25h後→全文', t => {
  const home = fixture(t);
  const now = Date.now();
  // セッションA で表示
  markShown({ home, hook: 'test-hook', sessionId: 'sess-a', ids: ['id-x', 'id-y'], now });
  // セッションB（24h以内）→ known
  const r1 = selectNew({ home, hook: 'test-hook', sessionId: 'sess-b', ids: ['id-x', 'id-y'], now: now + 60_000 });
  assert.equal(r1.fresh.length, 0);
  assert.equal(r1.known, 2);
  assert.equal(r1.knownFromOtherSessions, 2);
  // セッションB���25h後）→ fresh
  const r2 = selectNew({ home, hook: 'test-hook', sessionId: 'sess-b', ids: ['id-x', 'id-y'], now: now + 25 * 3600_000 });
  assert.equal(r2.fresh.length, 2);
  assert.equal(r2.known, 0);
});

test('<<autonomous-loop-dynamic>> prompt → isLoopWake が true', () => {
  assert.equal(isLoopWake({ prompt: '<<autonomous-loop-dynamic>>', session_id: 's' }), true);
  assert.equal(isLoopWake({ prompt: '<<autonomous-loop-static>>', session_id: 's' }), true);
  assert.equal(isLoopWake({ prompt: '/loop 5m /check', session_id: 's' }), true);
  assert.equal(isLoopWake({ prompt: '普通のプロンプト', session_id: 's' }), false);
});

test('同一セッションの直前の prompt と完全一致（6時間以内）→ isLoopWake が true', t => {
  const home = fixture(t);
  const now = Date.now();
  recordPrompt({ prompt: '進捗確認をお願いします', session_id: 's1' }, { home, now });
  assert.equal(isLoopWake({ prompt: '進捗確認をお願いします', session_id: 's1' }, { home, now: now + 60_000 }), true);
  // 6時間超 → false
  assert.equal(isLoopWake({ prompt: '進捗確認をお願いします', session_id: 's1' }, { home, now: now + 7 * 3600_000 }), false);
  // 別の prompt → false
  assert.equal(isLoopWake({ prompt: '別のプロンプト', session_id: 's1' }, { home, now: now + 60_000 }), false);
  // 別セッション → false
  assert.equal(isLoopWake({ prompt: '進捗確認をお願いします', session_id: 's2' }, { home, now: now + 60_000 }), false);
});

test('状態ファイルが壊れている／書けないとき hook は例外を投げず従来どおり動く', t => {
  const home = fixture(t);
  // 壊れた状態ファイル
  const shownFile = path.join(home, '.claude', 'inbox-display-shown.json');
  fs.mkdirSync(path.dirname(shownFile), { recursive: true });
  fs.writeFileSync(shownFile, 'invalid json{{{');
  const result = selectNew({ home, hook: 'test-hook', sessionId: 's', ids: ['id-a', 'id-b'] });
  assert.equal(result.fresh.length, 2);
  assert.equal(result.known, 0);
  // 書き込み不可能なパスでも落ちない
  markShown({ home: path.join(home, 'nonexistent', 'deep'), hook: 'test-hook', sessionId: 's', ids: ['id-a'] });
  assert.ok(true); // ここに到達すれば OK
});

test('selectNew は ids が空なら空を返す', () => {
  const result = selectNew({ hook: 'h', sessionId: 's', ids: [] });
  assert.equal(result.fresh.length, 0);
  assert.equal(result.known, 0);
});

test('selectNew は sessionId が無ければ全件 fresh', () => {
  const result = selectNew({ hook: 'h', ids: ['a', 'b'] });
  assert.equal(result.fresh.length, 2);
  assert.equal(result.known, 0);
});

test('isLoopWake は sessionId が無くても prompt が <<autonomous-loop なら true', () => {
  assert.equal(isLoopWake({ prompt: '<<autonomous-loop-dynamic>>' }), true);
  assert.equal(isLoopWake({ prompt: '普通のプロンプト' }), false);
});

test('recordPrompt は平文を保存しない（SHA-256 ハッシュのみ）', t => {
  const home = fixture(t);
  recordPrompt({ prompt: '秘密のメッセージ', session_id: 's1' }, { home });
  const file = path.join(home, '.claude', 'inbox-display-last-prompt.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(state.s1.hash);
  assert.notEqual(state.s1.hash, '秘密のメッセージ');
  assert.doesNotMatch(JSON.stringify(state), /秘密のメッセージ/);
});
test('selection records atomically, prunes old entries and tolerates an unwritable home', t => {
  const home = fixture(t), now = Date.now();
  const options = { home, hook: 'h', sessionId: 's', ids: ['a'], now };
  assert.deepEqual(selectNew(options), { fresh: ['a'], known: 0, knownFromOtherSessions: 0 });
  assert.deepEqual(selectNew({ ...options, ids: ['a', 'b'] }), { fresh: ['b'], known: 1, knownFromOtherSessions: 0 });
  assert.deepEqual(selectNew({ ...options, now: now + 31 * 86400_000 }), { fresh: ['a'], known: 0, knownFromOtherSessions: 0 });
  const blocked = path.join(home, 'file'); fs.writeFileSync(blocked, 'x');
  assert.deepEqual(selectNew({ ...options, home: blocked }), { fresh: ['a'], known: 0, knownFromOtherSessions: 0 });
  assert.equal(isLoopWake({ prompt: 'hello', session_id: 's' }, { home: blocked }), false);
});
test('prompt observation records hashes and isolates hooks on the same submission', t => {
  const home = fixture(t), input = { prompt: 'private text', session_id: 's' };
  assert.equal(isLoopWake(input, { home, hook: 'a' }), false);
  assert.equal(isLoopWake(input, { home, hook: 'b' }), false);
  assert.equal(isLoopWake(input, { home, hook: 'a' }), true);
  assert.doesNotMatch(fs.readFileSync(path.join(home, '.claude/inbox-display-last-prompt.json'), 'utf8'), /private text/);
});
