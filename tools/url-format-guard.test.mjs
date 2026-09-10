import test from 'node:test';
import assert from 'node:assert/strict';
import { findBrokenRawUrl } from './url-format-guard.mjs';

test('日本語が直後に続く生URLをblockする', () => {
  const result = findBrokenRawUrl('https://example.comを確認してください');
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /URL-FORMAT VIOLATION/);
});

test('Markdownリンクはpassする', () => {
  assert.deepEqual(findBrokenRawUrl('[example.com](https://example.com)'), { decision: 'pass' });
});

test('RAW-URL-OKタグ付きはpassする', () => {
  assert.deepEqual(findBrokenRawUrl('[RAW-URL-OK] https://example.comを確認'), { decision: 'pass' });
});
