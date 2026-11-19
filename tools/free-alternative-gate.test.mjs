import test from 'node:test';
import assert from 'node:assert/strict';
import { judge, judgeFreeAlternatives } from './decision-research-gate.mjs';
const checked = '[FREE-ALT-CHECKED: Beeperの既存LINE経路を当日実測し、接続停止で利用できないことを確認した]';
const free = '案1: 無料のBeeper経路（接続停止）';
const paid = '案2: 有料プラン 月額5,000円';
test('incident: paid first, wait, mail are blocked without asking words', () => {
  assert.equal(judge('案1: 有料プラン 月額5,000円\n案2: 12/1まで待つ\n案3: メール').triggered, true);
  assert.equal(judge(`${paid}\n${free}\n${checked}`).triggered, true);
});
test('free first AND measured evidence required', () => {
  assert.deepEqual(judgeFreeAlternatives(`${free}\n${paid}\n${checked}`), []);
  assert.equal(judgeFreeAlternatives(`${free}\n${paid}`).length, 1);
  assert.equal(judgeFreeAlternatives(`${free}\n${paid}\n[FREE-ALT-CHECKED: 調査済み]`).length, 1);
  assert.equal(judgeFreeAlternatives(`${paid}\n${checked}`).length, 1);
});
test('table, markdown and currency options', () => {
  const table = '| 案 | 月額 |\n|---|---|\n| 無料の既存ツール | 0円 |\n| Proへアップグレード | 5,000円 |';
  assert.deepEqual(judgeFreeAlternatives(`${table}\n${checked}`), []);
  assert.equal(judge(`${table}`).triggered, true);
  assert.equal(judge('1. Pro $20\n2. 無料の既存ツール').triggered, true);
});
test('RESEARCH-OK is not a free-route bypass; quoted PAID-OK is specific exception', () => {
  assert.equal(judge(`${paid}\n[RESEARCH-OK] 確認不要`).triggered, true);
  assert.equal(judge('課金してください [PAID-OK: 「このプランに課金して進めてください」]').triggered, false);
  assert.equal(judge(`${paid} [PAID-OK: 決定済み]`).triggered, true);
  assert.equal(judge(`${paid}\n> [PAID-OK: 「この課金をお願いします」]`).triggered, true);
});
test('facts, negative decisions, quotations and code are excluded', () => {
  for (const text of ['有料プランは不要と判断済み', '有料プランを提案した。テストは完了した。', '月額は5,000円だった。契約済みです。', '引用: 「案1: 有料プランにしてください」', '> 案1: 有料プランにしてください', '```\n案1: 購入してください\n```']) assert.equal(judge(text).triggered, false, text);
});
test('all requested paid words in option form trigger', () => {
  for (const word of ['有料プラン', '課金', 'アップグレード', '契約', '購入', '月額', '年額']) assert.equal(judge(`案1: ${word}\n案2: 待機`).triggered, true, word);
});
