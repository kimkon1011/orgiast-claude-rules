import test from 'node:test';
import assert from 'node:assert/strict';
import { bumpState, pruneState, shouldBlock } from './stop-gate.mjs';

test('1 完了報告と箇条書きの残TODOをblock', () => assert.equal(shouldBlock('完了しました。\n残TODO:\n- A を直す\n- B を消す'), true));
test('2 残TODOなしはpass', () => assert.equal(shouldBlock('完了しました。残TODO: なし'), false));
test('3 TODO-NONEはエスケープ優先', () => assert.equal(shouldBlock('完了しました。\n残TODO:\n- A\n\n[TODO-NONE]'), false));
test('4 質問で終わる場合はpass', () => assert.equal(shouldBlock('完了しました。\n残TODO:\n- A\nこれで進めて良いですか？'), false));
test('5 完了報告でなければpass', () => assert.equal(shouldBlock('調査中です'), false));
test('6 見出し後に箇条書きがなければpass', () => assert.equal(shouldBlock('完了しました。残TODO は特にありません'), false));
test('7 3回連続block後の4回目はblockしない', () => {
  let state = {};
  for (let i = 0; i < 3; i++) {
    const result = bumpState(state, 'session', true, new Date('2026-08-30T00:00:00Z'));
    assert.equal(result.blocked, true);
    state = result.state;
  }
  const fourth = bumpState(state, 'session', true, new Date('2026-08-30T00:00:00Z'));
  assert.equal(fourth.blocked, false);
});
test('8 途中で通したら連続カウントが0に戻る', () => {
  const first = bumpState({}, 'session', true, new Date('2026-08-30T00:00:00Z'));
  const passed = bumpState(first.state, 'session', false, new Date('2026-08-30T00:01:00Z'));
  assert.equal(passed.state.session.consecutive, 0);
});
test('9 24時間以上古いエントリを捨てる', () => {
  const state = {
    old: { consecutive: 2, updatedAt: '2026-08-28T23:59:59Z' },
    exact: { consecutive: 3, updatedAt: '2026-08-29T00:00:00Z' },
    fresh: { consecutive: 1, updatedAt: '2026-08-29T00:00:01Z' },
  };
  assert.deepEqual(pruneState(state, new Date('2026-08-30T00:00:00Z')), { fresh: state.fresh });
});
