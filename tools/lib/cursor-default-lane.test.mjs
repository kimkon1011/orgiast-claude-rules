import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isClaudeFinalOnly,
  isCursorDefaultKind,
  isCursorLongTimeoutKind,
  shouldPreferCursorAgent,
} from './cursor-default-lane.mjs';

test('Cursor は既定 OFF、明示オプトイン時だけ旧互換の対象種類で有効', () => {
  for (const kind of ['implement', 'verify', 'investigate', 'summarize', 'classify']) {
    assert.equal(isCursorDefaultKind(kind), true);
    assert.equal(shouldPreferCursorAgent({ kind, instruction: '期日を回収してまとめる' }), false);
    assert.equal(shouldPreferCursorAgent({ kind, instruction: '期日を回収してまとめる', env: { CODEX_DO_ENABLE_CURSOR_AGENT: '1' } }), true);
  }
  assert.equal(isCursorDefaultKind('review'), false);
  assert.equal(shouldPreferCursorAgent({ kind: 'review', instruction: 'レビュー' }), false);
});

test('金さん向け最終判断と社外文面の最終確認は Claude に残し Cursor を使わない', () => {
  assert.equal(isClaudeFinalOnly('これは金さん向けの最終判断として文面を確認する'), true);
  assert.equal(isClaudeFinalOnly('社外文面の最終確認をしてから送る'), true);
  assert.equal(isClaudeFinalOnly('lane: claude で最終確認'), true);
  assert.equal(isClaudeFinalOnly('[CLAUDE-FINAL] 対外発表文'), true);
  assert.equal(isClaudeFinalOnly('くらしのマーケットの見回り結果を集計する'), false);
  assert.equal(shouldPreferCursorAgent({
    kind: 'summarize',
    instruction: '社外文面の最終確認をお願いします',
  }), false);
});

test('SKIP または halt のときは Cursor を既定にしない', () => {
  assert.equal(shouldPreferCursorAgent({
    kind: 'implement',
    instruction: '修正PRを出す',
    env: { CODEX_DO_ENABLE_CURSOR_AGENT: '1', CODEX_DO_SKIP_CURSOR_AGENT: '1' },
  }), false);
  assert.equal(shouldPreferCursorAgent({
    kind: 'implement',
    instruction: '修正PRを出す',
    env: { CODEX_DO_ENABLE_CURSOR_AGENT: '1' },
    halt: true,
  }), false);
  assert.equal(shouldPreferCursorAgent({
    kind: 'implement',
    instruction: '修正PRを出す',
    env: { CODEX_DO_ENABLE_CURSOR_AGENT: '1', CURSOR_USAGE_HALT: '1' },
  }), false);
});

test('調べ物・集計・実装は長めのタイムアウト対象', () => {
  assert.equal(isCursorLongTimeoutKind('implement'), true);
  assert.equal(isCursorLongTimeoutKind('investigate'), true);
  assert.equal(isCursorLongTimeoutKind('summarize'), true);
  assert.equal(isCursorLongTimeoutKind('classify'), false);
});
