import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detect, inspect, selftest, CONTROLS, scan,
} from './handoff-audit-lane-limit-abandonment-scan.mjs';

test('selftest: 対照 9/9（陽性4・陰性5）', () => {
  const r = selftest();
  assert.equal(r.total, 9);
  assert.deepEqual(r.failures, []);
});

test('原文（usage limit クールダウン中＋修復不可）を検出する', () => {
  const text = '[LANE-REPAIR] codex: 修復不可 試行: このセッションで codex-do を3回試し、3回とも「Codex usage limit クールダウン中」と出た。';
  const r = inspect(text);
  assert.equal(r.hit, true);
  assert.equal(r.exempt, '');
  assert.equal(detect(text), true);
});

test('lane-doctor --probe を実行した turn は修復済みとして除外する', () => {
  const text = '[LANE-REPAIR] codex: 修復不可。試したことは次の3つです。\n- `lane-doctor --probe` を 10:25Z に実行 → codex は不通、生きている実装役は deepseek。\n- `codex exec` → 「You\'ve hit your usage limit」';
  const r = inspect(text);
  assert.equal(r.hit, true);
  assert.equal(r.exempt, 'doctor');
  assert.equal(detect(text), false);
});

test('明示フォールバック [LANE-FALLBACK] は除外する', () => {
  assert.equal(detect('[LANE-FALLBACK] codex が usage limit。deepseek に委譲して完了。'), false);
});

test('監査 TODO 文そのものは数えない', () => {
  assert.equal(detect('9. [handoff-audit:13f5d2c0ea6be788] 他AIレーン（Codex等）の usage limit / cooldown で作業が止まった — 検証する'), false);
});

test('窓の外（250文字超）の語では検出しない', () => {
  assert.equal(detect('レーンの説明。' + 'あ'.repeat(300) + ' usage limit のテストを足しました。次回の予定はありません。'), false);
});

test('scan は since より前の行を数えない', () => {
  const r = scan({ since: Date.parse('2999-01-01T00:00:00Z'), roots: [] });
  assert.equal(r.hits, 0);
  assert.equal(r.transcript.turns, 0);
});

test('CONTROLS は陽性4・陰性5', () => {
  assert.equal(CONTROLS.filter(c => c.want).length, 4);
  assert.equal(CONTROLS.filter(c => !c.want).length, 5);
});
