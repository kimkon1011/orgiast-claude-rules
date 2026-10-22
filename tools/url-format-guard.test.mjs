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

test('全角括弧が直後に続く GitHub URL をblockする（2026-10-18 実害）', () => {
  assert.equal(findBrokenRawUrl('https://github.com/kimkon1011/orgiast-claude-rules/pull/864（**kimkon1011** で開く）').decision, 'block');
  for (const tail of ['）', '」', '、', '。', ')', ']']) assert.equal(findBrokenRawUrl(`(https://github.com/org/repo${tail}`).decision, 'block', tail);
});

test('単独行・リンク文字列・コードはpassする', () => {
  assert.equal(findBrokenRawUrl('**kimkon1011** で開いてください。\nhttps://github.com/kimkon1011/orgiast-claude-rules/pull/864\n').decision, 'pass');
  assert.equal(findBrokenRawUrl('[https://github.com/org/repo](https://github.com/org/repo)（**kim** で開く）').decision, 'pass');
  assert.equal(findBrokenRawUrl("```js\nfetch('https://example.com')\n```\n`https://example.com`を参照").decision, 'pass');
});
