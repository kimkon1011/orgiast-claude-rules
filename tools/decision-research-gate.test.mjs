import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, formatReason } from './decision-research-gate.mjs';

test('比較なしで有料化を勧めると差し戻す（2026-10-10 実例）', () => {
  const text = '有料にする必要がある。ChatGPT Business の管理画面で cr@ と nishi@ をメンバーに追加してください。\n次に kim がすること: メンバー招待';
  const r = judge(text);
  assert.equal(r.triggered, true);
  assert.ok(r.missing.some(m => /比較表/.test(m)));
  assert.ok(r.missing.some(m => /出典/.test(m)));
  assert.match(formatReason(r.missing), /RESEARCH-FIRST/);
});

test('比較表・費用・枠・出典・推奨があれば通す', () => {
  const text = [
    '| 案 | 月額 | Codex 枠 | 手間 |',
    '|---|---|---|---|',
    '| A. 個別 Plus | +$40 | Plus 3つ分 | 2台で再ログイン |',
    '| C. Pro 5x | +$80 | Plus 5つ分 | なし |',
    'おすすめは C。出典: https://chatgpt.com/codex/pricing/',
    '次に kim がすること: A か C かを一言で返す（プランを変更）',
  ].join('\n');
  assert.equal(judge(text).triggered, false);
});

test('費用判断を求めていない応答・明示の例外は対象外', () => {
  assert.equal(judge('テストは 89 件 pass。次に kim がすること: なし').triggered, false);
  assert.equal(judge('有料プランに切り替えてください [RESEARCH-OK] 契約は既に kim が決定済み').triggered, false);
});

test('コードブロック内の語は数えない', () => {
  assert.equal(judge('```\n購入 契約 してください\n```\n完了した。').triggered, false);
});
