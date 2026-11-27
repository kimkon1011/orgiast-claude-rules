import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findKimDecision, shouldAskKim, toNextActionSuppressRules, loadKimDecisionLedger } from './kim-decision-ledger.mjs';
import { filterLandedAndSuppressed } from './next-actions.mjs';

test('dodaキャンペーンは申し込まないと出して、金さんに聞かない', () => {
  const q = 'doda掲載キャンペーン（12週間28万円、期限は本日11/27）：申し込む／見送る';
  const result = shouldAskKim(q);
  assert.equal(result.ask, false);
  assert.equal(result.id, 'KIM-20261126-doda-campaign');
  assert.match(result.answer, /申し込まない/);
});

test('doda経由の応募者メールは対象外で聞いてよい（通常対応）', () => {
  const q = 'doda経由で応募者の履歴書が届いた。一次面接の日程を出してよいか';
  assert.equal(shouldAskKim(q).ask, true);
  assert.equal(findKimDecision(q), null);
});

test('労働審判の11問は再質問しない', () => {
  const result = shouldAskKim('労働審判の答弁書の提出日と署名押印、11/28の印刷と発送は誰に頼みますか');
  assert.equal(result.ask, false);
  assert.equal(result.id, 'KIM-20261127-roudou-q1-q11');
  assert.match(result.answer, /11月28日/);
});

test('乳癌学会T-6810は振込GO済みとして聞かない', () => {
  const result = shouldAskKim('11/30 第22回日本乳癌学会 請求書 T-6810 の振込：誰が振り込みますか');
  assert.equal(result.ask, false);
  assert.equal(result.id, 'KIM-20261126-nyugan-T6810');
});

test('決定台帳は next-actions の抑止ルールに載る', () => {
  const rules = toNextActionSuppressRules().map((rule) => ({ ...rule, regex: new RegExp(rule.pattern, 'i') }));
  const { actions, excluded } = filterLandedAndSuppressed([
    { title: 'doda 掲載キャンペーン（12週間 28万円）に申し込むか' },
    { title: '別件の見積を出すか' },
  ], { suppressRules: rules });
  assert.equal(actions.length, 1);
  assert.match(actions[0].title, /見積/);
  assert.equal(excluded.length, 1);
  assert.match(excluded[0].reason, /KIM-20261126-doda-campaign/);
});

test('台帳が読めて ACTIVE のみ', () => {
  const ledger = loadKimDecisionLedger();
  assert.ok(ledger.some((item) => item.id === 'KIM-20261126-doda-campaign'));
  assert.ok(ledger.every((item) => item.status === 'ACTIVE'));
});
