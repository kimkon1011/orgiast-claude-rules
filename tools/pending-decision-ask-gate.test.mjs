import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePendingDecision } from './pending-decision-ask-gate.mjs';

const row = '| Indeed の有料広告・助太刀 | どちらも止めたまま（社長の判断待ち） |';

test('判断待ちの主題を kim に聞いていなければ block', () => {
  const result = evaluatePendingDecision(`${row}\n\n【kim 確認用の全文】\n別件を確認してください。`);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /Indeed の有料広告・助太刀/);
});

test('判断待ちの主題を確認全文で聞いていれば pass', () => {
  const result = evaluatePendingDecision(`${row}\n\n【kim 確認用の全文】\n有料広告を再開するか選んでください。推奨は再開です。`);
  assert.equal(result.decision, 'pass');
});

test('受信箱節だけの判断待ちは対象外', () => {
  const result = evaluatePendingDecision('【受信箱】\n| Indeed の有料広告・助太刀 | 社長の判断待ち |\n\n【最終まとめ】\n完了しました。');
  assert.equal(result.decision, 'pass');
});
