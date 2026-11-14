/**
 * X-0007: ai-mention-checker.mjs のテスト
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseArgs, analyzeResults, parseDuckDuckGoResults, formatMarkdown } from './ai-mention-checker.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI_PATH = path.join(__dirname, 'ai-mention-checker.mjs');

test('CLI: --help がヘルプを表示して正常終了する', () => {
  const result = spawnSync(process.execPath, [CLI_PATH, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /使い方:/);
  assert.match(result.stdout, /--query/);
});

test('CLI: --query なしはエラー終了する', () => {
  const result = spawnSync(process.execPath, [CLI_PATH], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--query は必須/);
});

// ── parseArgs ──

test('parseArgs: --help を認識する', () => {
  const result = parseArgs(['node', 'test.mjs', '--help']);
  assert.equal(result.help, true);
});

test('parseArgs: --query を認識する', () => {
  const result = parseArgs(['node', 'test.mjs', '--query', 'テストクエリ']);
  assert.equal(result.query, 'テストクエリ');
});

test('parseArgs: --query なしの場合エラーにならず undefined', () => {
  const result = parseArgs(['node', 'test.mjs']);
  assert.equal(result.query, undefined);
});

test('parseArgs: --json を認識する', () => {
  const result = parseArgs(['node', 'test.mjs', '--json']);
  assert.equal(result.json, true);
});

test('parseArgs: --provider を認識する', () => {
  const result = parseArgs(['node', 'test.mjs', '--provider', 'groq']);
  assert.equal(result.provider, 'groq');
});

test('parseArgs: --output を認識する', () => {
  const result = parseArgs(['node', 'test.mjs', '--output', '/tmp/report.md']);
  assert.equal(result.output, '/tmp/report.md');
});

test('parseArgs: 複数オプションを同時に認識する', () => {
  const result = parseArgs([
    'node', 'test.mjs',
    '--query', '展示会 ブース',
    '--provider', 'deepseek',
    '--json',
  ]);
  assert.equal(result.query, '展示会 ブース');
  assert.equal(result.provider, 'deepseek');
  assert.equal(result.json, true);
});

// ── analyzeResults ──

test('analyzeResults: orgiast.jp を含むURLを検出する', () => {
  const results = [
    { title: 'テスト', url: 'https://www.orgiast.jp/booth/', snippet: '説明文' },
    { title: '他社', url: 'https://example.com/', snippet: '他社の説明' },
  ];
  const score = analyzeResults(results);
  assert.equal(score.present, true);
  assert.equal(score.mentionCount, 1);
  assert.equal(score.totalResults, 2);
  assert(score.mentionRate > 0 && score.mentionRate < 1);
});

test('analyzeResults: オージャスト を含むタイトルを検出する', () => {
  const results = [
    { title: '株式会社オージャストの展示会サービス', url: 'https://example.com/', snippet: '' },
    { title: '他社', url: 'https://other.com/', snippet: '' },
  ];
  const score = analyzeResults(results);
  assert.equal(score.present, true);
  assert.equal(score.mentionCount, 1);
});

test('analyzeResults: オージャスト を含むスニペットを検出する', () => {
  const results = [
    { title: '展示会ガイド', url: 'https://example.com/', snippet: '株式会社オージャストが解説します' },
  ];
  const score = analyzeResults(results);
  assert.equal(score.present, true);
  assert.equal(score.mentionCount, 1);
});

test('analyzeResults: 言及なしの場合 present=false になる', () => {
  const results = [
    { title: '他社A', url: 'https://a.com/', snippet: '他社の情報' },
    { title: '他社B', url: 'https://b.com/', snippet: '別の情報' },
  ];
  const score = analyzeResults(results);
  assert.equal(score.present, false);
  assert.equal(score.mentionCount, 0);
  assert.equal(score.mentionRate, 0);
});

test('analyzeResults: 空配列でもエラーにならない', () => {
  const score = analyzeResults([]);
  assert.equal(score.present, false);
  assert.equal(score.mentionCount, 0);
  assert.equal(score.totalResults, 0);
  assert.equal(score.mentionRate, 0);
});

test('analyzeResults: 複数マッチのカウントが正しい', () => {
  const results = [
    { title: 'オージャスト', url: 'https://orgiast.jp/', snippet: '素晴らしい' },
    { title: '別の結果', url: 'https://orgiast.jp/service/', snippet: 'サービス' },
    { title: '他社', url: 'https://other.com/', snippet: '他社' },
  ];
  const score = analyzeResults(results);
  assert.equal(score.mentionCount, 2);
  assert.equal(score.totalResults, 3);
  assert.equal(score.mentionRate, 2 / 3);
});

test('analyzeResults: snippets 配列に該当結果が含まれる', () => {
  const results = [
    { title: '株式会社オージャスト', url: 'https://orgiast.jp/', snippet: 'テスト' },
  ];
  const score = analyzeResults(results);
  assert.equal(score.snippets.length, 1);
  assert.equal(score.snippets[0].title, '株式会社オージャスト');
  assert.equal(score.snippets[0].url, 'https://orgiast.jp/');
});

// ── parseDuckDuckGoResults ──

test('parseDuckDuckGoResults: 空のHTMLは空配列を返す', () => {
  const result = parseDuckDuckGoResults('<html></html>');
  assert.deepEqual(result, []);
});

test('parseDuckDuckGoResults: リンクとスニペットをパースする', () => {
  const html = `<html>
<body>
<div class="result">
  <a rel="nofollow" href="https://example.com/page1" class="result-link">Example Title</a>
  <td class="result-snippet">Example description here.</td>
</div>
<div class="result">
  <a rel="nofollow" href="https://test.org/page2" class="result-link">Test Page</a>
  <td class="result-snippet">Test snippet content.</td>
</div>
</body>
</html>`;
  const result = parseDuckDuckGoResults(html);
  assert.equal(result.length, 2);
  assert.equal(result[0].title, 'Example Title');
  assert.equal(result[0].url, 'https://example.com/page1');
  assert.equal(result[0].snippet, 'Example description here.');
  assert.equal(result[1].title, 'Test Page');
  assert.equal(result[1].url, 'https://test.org/page2');
});

// ── formatMarkdown ──

test('formatMarkdown: 言及ありのレポートを生成する', () => {
  const score = {
    present: true,
    mentionCount: 2,
    totalResults: 10,
    mentionRate: 0.2,
    snippets: [
      { title: '株式会社オージャスト', url: 'https://orgiast.jp/', snippet: '説明文' },
    ],
  };
  const md = formatMarkdown(score, 'テストクエリ', 'gemini');
  assert(md.includes('テストクエリ'));
  assert(md.includes('gemini'));
  assert(md.includes('20.0%')); // 0.2 → 20.0%
  assert(md.includes('✅'));
  assert(md.includes('株式会社オージャスト'));
  assert(md.includes('https://orgiast.jp/'));
});

test('formatMarkdown: 言及なしのレポートを生成する', () => {
  const score = {
    present: false,
    mentionCount: 0,
    totalResults: 5,
    mentionRate: 0,
    snippets: [],
  };
  const md = formatMarkdown(score, 'テスト', 'groq');
  assert(md.includes('❌'));
  assert(md.includes('見つかりませんでした'));
});

// ── JSON出力フォーマット ──

test('analyzeResults: JSON形式で出力可能な構造を持つ', () => {
  const results = [
    { title: 'オージャスト', url: 'https://orgiast.jp/', snippet: 'テスト' },
  ];
  const score = analyzeResults(results);
  const json = JSON.stringify(score);
  const parsed = JSON.parse(json);
  assert.equal(typeof parsed.present, 'boolean');
  assert.equal(typeof parsed.mentionCount, 'number');
  assert.equal(typeof parsed.totalResults, 'number');
  assert.equal(typeof parsed.mentionRate, 'number');
  assert(Array.isArray(parsed.snippets));
});
