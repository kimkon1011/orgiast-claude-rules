import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMarkdownText, verifyReadback } from './gdoc-update.mjs';

test('Markdown 記号を読み戻し比較用のプレーンテキストに正規化する', () => {
  assert.equal(normalizeMarkdownText('# **見出しテキスト**'), '見出しテキスト');
  assert.equal(normalizeMarkdownText('> * 箇条書きの文'), '箇条書きの文');
  assert.equal(normalizeMarkdownText('| a | b |'), 'a b');
});

test('Markdown 見出しと強調を除いて read-back の一致を検証する', () => {
  const markdown = '# **ラハイナ PayPay銀行 法人口座開設 準備書**';
  const exported = 'ラハイナ PayPay銀行 法人口座開設 準備書\n本文…';
  assert.equal(verifyReadback(markdown, exported), true);
});

test('無関係または空の read-back は失敗と判定する', () => {
  const markdown = '# **ラハイナ PayPay銀行 法人口座開設 準備書**';
  assert.equal(verifyReadback(markdown, '無関係なテキスト'), false);
  assert.equal(verifyReadback(markdown, ''), false);
});
