import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isLaneIncompatible,
  modelWarningRemainder,
  TRUST_WARNING_LINE,
} from '../tools/lib/lane-incompatible.mjs';

// auto-session 枠 8 の実 stderr（runs/2026-11-2{5,6,7}-8.json）。
const STDERR_2026_11_25 = [
  '[openrouter:deepseek/deepseek-v4-flash]',
  'Ignoring 1 permissions.allow entry from .claude/settings.local.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["d:/CLAUDE.md配布"].hasTrustDialogAccepted: true in C:\\Users\\kimko\\.claude\\cheap-code-worker\\.claude.json.',
  '[claude-code:unrecognized_model] {"model":"deepseek/deepseek-v4-flash","query_source":"sdk"}',
].join('\n');

const STDERR_2026_11_26 = [
  '[openrouter:deepseek/deepseek-v4-flash]',
  '[claude-code:unrecognized_model] {"model":"deepseek/deepseek-v4-flash","query_source":"sdk"}',
].join('\n');

const STDERR_2026_11_27 = [
  '[openrouter:deepseek/deepseek-v4-flash]',
  'Ignoring 114 permissions.allow entries from .claude/settings.json: this workspace has not been trusted. Run Claude Code interactively here once and accept the trust dialog, or set projects["C:/Users/kimko"].hasTrustDialogAccepted: true in C:\\Users\\kimko\\.claude\\cheap-code-worker\\.claude.json.',
  '[claude-code:unrecognized_model] {"model":"deepseek/deepseek-v4-flash","query_source":"sdk"}',
].join('\n');

test('TRUST_WARNING_LINE は entry / entries の両方にマッチする', () => {
  assert.equal(
    TRUST_WARNING_LINE.test(
      'Ignoring 1 permissions.allow entry from .claude/settings.local.json: this workspace has not been trusted.'
    ),
    true
  );
  assert.equal(
    TRUST_WARNING_LINE.test(
      'Ignoring 114 permissions.allow entries from .claude/settings.json: this workspace has not been trusted.'
    ),
    true
  );
});

test('11/26-8 実データ: 空 stdout + unrecognized_model → incompatible', () => {
  assert.equal(modelWarningRemainder('\n', STDERR_2026_11_26), '');
  assert.equal(isLaneIncompatible('\n', STDERR_2026_11_26, 0), true);
});

test('11/27-8 実データ: trust 警告（entries）があっても空振りは incompatible', () => {
  assert.equal(modelWarningRemainder('\n', STDERR_2026_11_27), '');
  assert.equal(isLaneIncompatible('\n', STDERR_2026_11_27, 0), true);
});

test('11/25-8 実データ: 単数 entry の trust 警告も残差から落ち、空振りなら incompatible', () => {
  assert.equal(modelWarningRemainder('\n', STDERR_2026_11_25), '');
  assert.equal(isLaneIncompatible('\n', STDERR_2026_11_25, 0), true);
});

test('11/25-8 実データ: stdout に回答があれば success 維持（フォールバックしない）', () => {
  const stdout =
    'next-session.md は変更不要（PR #8 は依然 Kim の A/B 判断待ち、その他残TODOも状態変化なし）。\n';
  assert.ok(modelWarningRemainder(stdout, STDERR_2026_11_25).includes('next-session.md'));
  assert.equal(isLaneIncompatible(stdout, STDERR_2026_11_25, 0), false);
});
