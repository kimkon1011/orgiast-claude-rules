import assert from 'node:assert/strict';
import test from 'node:test';
import { budgetVerdict, estimateTokens, noteResponse, parseDuration, refreshEntry } from './rate-budget.mjs';

test('parseDuration は groq の複合表記を解釈する', () => {
  assert.equal(parseDuration('547ms'), 547);
  assert.equal(parseDuration('3h12m57.6s'), 3 * 3600000 + 12 * 60000 + 57600);
  assert.equal(parseDuration('1m30s'), 90000);
});

test('parseDuration は想定外の書式で null を返す(誤った窓で締め切らない)', () => {
  assert.equal(parseDuration('すぐ'), null);
  assert.equal(parseDuration('30'), null); // 単位なしは解釈しない
  assert.equal(parseDuration('1m extra'), null); // 解釈できない残りがあるなら捨てる
  assert.equal(parseDuration(null), null);
  assert.equal(parseDuration(''), null);
});

test('estimateTokens は本文長から安全側に多めに見積もる', () => {
  assert.equal(estimateTokens({ init: { body: 'x'.repeat(400) } }), 120); // 400/4 * 1.2
  assert.equal(estimateTokens({ init: {} }), 0);
  assert.equal(estimateTokens(null), 0);
});

test('refreshEntry は窓が明けたら残量を満タンに戻す', () => {
  const entry = { limitTokens: 8000, remainingTokens: 100, tokensResetAt: 1000 };
  assert.equal(refreshEntry(entry, 999).remainingTokens, 100);
  assert.equal(refreshEntry(entry, 1000).remainingTokens, 8000);
  assert.equal(refreshEntry(entry, 2000).tokensResetAt, null);
});

test('budgetVerdict: 未計測の provider は素通し', () => {
  assert.deepEqual(budgetVerdict({ store: {}, provider: 'groq', neededTokens: 99999 }), { allow: true, remaining: null });
});

test('budgetVerdict: 残量 < 見積 で拒否、足りていれば許可', () => {
  const store = { groq: { limitTokens: 8000, remainingTokens: 500, tokensResetAt: null } };
  assert.equal(budgetVerdict({ store, provider: 'groq', neededTokens: 700 }).allow, false);
  assert.equal(budgetVerdict({ store, provider: 'groq', neededTokens: 500 }).allow, true); // 同値は通す
});

test('budgetVerdict: 窓明けなら満タンで判定する', () => {
  const store = { groq: { limitTokens: 8000, remainingTokens: 10, tokensResetAt: 1000 } };
  assert.equal(budgetVerdict({ store, provider: 'groq', neededTokens: 3000, now: 2000 }).allow, true);
});

test('noteResponse は残量ヘッダを下限として記録する', () => {
  const store = {};
  const ok = noteResponse(store, 'groq', new Headers({
    'x-ratelimit-limit-tokens': '8000',
    'x-ratelimit-remaining-tokens': '7927',
    'x-ratelimit-reset-tokens': '547ms',
  }), 1000);
  assert.equal(ok, true);
  assert.deepEqual(store.groq, { limitTokens: 8000, remainingTokens: 7927, tokensResetAt: 1547, updatedAt: 1000 });
});

test('noteResponse は残量ヘッダが無ければ何も書かない(既存挙動を変えない)', () => {
  const store = {};
  assert.equal(noteResponse(store, 'cerebras', new Headers({ 'x-request-id': 'r' }), 1000), false);
  assert.equal(noteResponse(store, 'cerebras', null, 1000), false);
  assert.deepEqual(store, {});
});
