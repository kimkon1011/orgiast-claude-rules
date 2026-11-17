import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyZone, generateHTML, parseCSV } from './gsc-bubble-chart.mjs';

test('Queries.csv の割合CTRと引用フィールドを読み込む', () => {
  const rows = parseCSV('Query,Impressions,Clicks,Position,CTR\r\n"展示会, ブース",1,234,3.2,4%\r\n');
  assert.deepEqual(rows, [{ query: '展示会, ブース', impressions: 1, clicks: 234, position: 3.2, ctr: 0.04 }]);
});

test('Pages.csv の Page カラムとフィールド内改行を読み込む', () => {
  const rows = parseCSV('Page,Impressions,Clicks,Position,CTR\n"https://example.test/a\ncontinued",1000,20,12.4,0.02\n');
  assert.equal(rows[0].query, 'https://example.test/a\ncontinued');
  assert.equal(rows[0].impressions, 1000);
});

test('3ゾーンを仕様の優先順位で分類する', () => {
  assert.equal(classifyZone(5, 0.049), 'mismatch');
  assert.equal(classifyZone(15, 0.01), 'potential');
  assert.equal(classifyZone(25, 0.10), 'potential');
  assert.equal(classifyZone(25, 0.01), 'assess');
});

test('HTML埋め込み値をエスケープする', () => {
  const html = generateHTML([
    { query: '</script><script>alert(1)</script>', impressions: 10, clicks: 1, position: 2, ctr: 0.1 },
  ], { siteName: '<img src=x onerror=alert(1)>' });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<\/script><script>alert/);
  assert.match(html, /\\u003c\/script\\u003e/);
});
