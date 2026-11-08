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

const humanOptions = [
  '| 案 | 手間 |',
  '|---|---|',
  '| A. 佐藤さんに DM で再送を頼む（推奨） | 再入力1回 |',
  '| B. 購買部にフォーム回答の確認を依頼 | 確認1回 |',
  '| C. 何もしない | なし |',
].join('\n');
const autoOption = '| Claude 自身が Forms API で回答を取得して復元する | 自動経路 |';
const triedRoute = 'Claude が試した経路: Forms API。結果: 403、権限なしで失敗。';

test('他メンバーへの再送DMを推奨する比較表はblock', () => {
  const result = judge(`${humanOptions}\n次に kim がすること: 佐藤さんへの DM を送ってよいか返す`);
  assert.equal(result.triggered, true);
  assert.ok(result.missing.some(m => /先頭/.test(m)));
  assert.ok(result.missing.some(m => /試した経路と結果/.test(m)));
  assert.match(formatReason(result.missing), /Claude 自身が実行する案（自動経路）を先頭/);
});

test('Claude自身の実行案が先頭で試した経路と結果があればpass', () => {
  const table = humanOptions.replace('| A.', `${autoOption}\n| A.`);
  assert.equal(judge(`${table}\n${triedRoute}`).triggered, false);
  assert.equal(judge(table).triggered, true);
  assert.equal(judge(`${table}\nForms API を試行します。成功する予定です。`).triggered, true);
});

test('試行結果があってもClaude案が後ろならblock', () => {
  const result = judge(`${humanOptions}\n${autoOption}\n${triedRoute}`);
  assert.equal(result.triggered, true);
  assert.ok(result.missing.some(m => /先頭/.test(m)));
});

test('人への依頼がない通常の比較表は対象外', () => {
  assert.equal(judge('| 案 | 結果 |\n|---|---|\n| Forms API | 回答取得 |\n| Drive revisions | 版取得 |').triggered, false);
});
