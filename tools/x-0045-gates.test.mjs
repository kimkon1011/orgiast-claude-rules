import assert from 'node:assert';
import { describe, it } from 'node:test';
import { evaluateSilentCheckFailure } from './silent-check-failure-gate.mjs';
import { evaluateExternalChannelPromise } from './external-channel-unmonitored-gate.mjs';
import { evaluateStaleWorktree } from './stale-worktree-gate.mjs';

describe('silent-check-failure-gate', () => {
  it('pass on normal completion report', () => {
    const result = evaluateSilentCheckFailure('実装完了しました。typecheck PASS ✅');
    assert.equal(result.decision, 'pass');
  });

  it('pass on explicit failure report', () => {
    const result = evaluateSilentCheckFailure('check_error を検出しました。exit 1 を確認。修復が必要です。');
    assert.equal(result.decision, 'pass');
  });

  it('warn on check success claim with failure signal', () => {
    const result = evaluateSilentCheckFailure('全 check PASS しました。executeCheck が完了。MODULE_NOT_FOUND は解消済み。');
    assert.equal(result.decision, 'warn');
    assert.ok(result.reason.includes('SILENT-CHECK-FAILURE'));
  });

  it('pass on code-block-only failure signal', () => {
    const result = evaluateSilentCheckFailure('完了しました。\n```\nerror: MODULE_NOT_FOUND\n```');
    assert.equal(result.decision, 'pass');
  });

  it('pass on dry-run', () => {
    const result = evaluateSilentCheckFailure('dry-run の check を実行しました。exit 1 でしたが dry-run なので問題なし。');
    assert.equal(result.decision, 'pass');
  });

  it('pass on test output', () => {
    const result = evaluateSilentCheckFailure('check 完了。test/spec.test.mjs の exit code 1 は既知。');
    assert.equal(result.decision, 'pass');
  });

  it('pass on empty text', () => {
    assert.equal(evaluateSilentCheckFailure('').decision, 'pass');
  });
});

describe('external-channel-unmonitored-gate', () => {
  it('pass on normal text', () => {
    const result = evaluateExternalChannelPromise('実装完了しました。');
    assert.equal(result.decision, 'pass');
  });

  it('pass on Gmail-only reply wait', () => {
    const result = evaluateExternalChannelPromise('メールの返信待ちです。');
    assert.equal(result.decision, 'pass');
  });

  it('block on LINE reply wait promise', () => {
    const result = evaluateExternalChannelPromise('LINE の返信待ちです。回答が届いたら進めます。');
    assert.equal(result.decision, 'block');
    assert.ok(result.reason.includes('EXTERNAL-CHANNEL-UNMONITORED'));
  });

  it('pass on past tense', () => {
    const result = evaluateExternalChannelPromise('LINE に返信しました。');
    assert.equal(result.decision, 'pass');
  });

  it('pass on user directive', () => {
    const result = evaluateExternalChannelPromise('kimからLINEで返事を待つように指示がありました。');
    assert.equal(result.decision, 'pass');
  });

  it('pass on code block reference', () => {
    const result = evaluateExternalChannelPromise('完了しました。\n```\nLINE の返信待ち\n```');
    assert.equal(result.decision, 'pass');
  });

  it('block on Discord reply wait', () => {
    const result = evaluateExternalChannelPromise('Discord の返信が届いたら次の作業に進みます。');
    assert.equal(result.decision, 'block');
  });
});

describe('stale-worktree-gate', () => {
  it('pass on nightly-repo path', () => {
    const result = evaluateStaleWorktree('node tools/auto-progress.mjs', 'C:\\Users\\kimko\\.claude\\nightly-repo');
    assert.equal(result.decision, 'pass');
  });

  it('block on auto-session-repo path', () => {
    const result = evaluateStaleWorktree('node tools/auto-progress.mjs', 'C:\\Users\\kimko\\.claude\\auto-session-repo');
    assert.equal(result.decision, 'block');
    assert.ok(result.reason.includes('STALE-WORKTREE'));
  });

  it('pass on read-only command', () => {
    const result = evaluateStaleWorktree('git status', 'C:\\Users\\kimko\\.claude\\auto-session-repo');
    assert.equal(result.decision, 'pass');
  });

  it('pass on management command', () => {
    const result = evaluateStaleWorktree('git worktree add /tmp/test main', 'C:\\Users\\kimko\\.claude\\auto-session-repo');
    assert.equal(result.decision, 'pass');
  });

  it('pass on dry-run', () => {
    const result = evaluateStaleWorktree('node tools/auto-progress.mjs --dry-run', 'C:\\Users\\kimko\\.claude\\auto-session-repo');
    assert.equal(result.decision, 'pass');
  });

  it('block on orgiast-main path', () => {
    const result = evaluateStaleWorktree('node tools/auto-progress.mjs', 'C:\\Users\\kimko\\orgiast-main');
    assert.equal(result.decision, 'block');
  });

  it('pass on .claude path', () => {
    const result = evaluateStaleWorktree('node tools/setup.mjs', 'C:\\Users\\kimko\\.claude\\auto-session-repo\\.claude');
    assert.equal(result.decision, 'pass');
  });

  it('pass on empty command', () => {
    assert.equal(evaluateStaleWorktree('', '').decision, 'pass');
  });
});