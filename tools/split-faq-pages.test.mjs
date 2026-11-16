/**
 * X-0007: split-faq-pages.mjs のテスト
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePages, main, INPUT_FILE } from './split-faq-pages.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// テスト用のモック入力（最小限の3ページ構成）
const MOCK_INPUT = `<!-- ============================================================ -->
<!-- X-0007: AI検索向けFAQ テスト用ヘッダー -->
<!-- ============================================================ -->

<!-- ============================================================ -->
<!-- ページ1: テストページ1 -->
/* スラッグ: /booth/faq/test-page-one/ */
<!-- ============================================================ -->

<h2>テスト質問1</h2>
<p>回答1</p>
<script type="application/ld+json">{"@type":"FAQPage"}</script>

<hr>

<!-- ============================================================ -->
<!-- ページ2: テストページ2 -->
/* スラッグ: /booth/faq/test-page-two/ */
<!-- ============================================================ -->

<h2>テスト質問2</h2>
<p>回答2</p>
<script type="application/ld+json">{"@type":"FAQPage"}</script>

<hr>

<!-- ============================================================ -->
<!-- ページ3: テストページ3 -->
/* スラッグ: /booth/faq/test-page-three/ -->
<!-- ============================================================ -->

<h2>テスト質問3</h2>
<p>回答3</p>
<script type="application/ld+json">{"@type":"FAQPage"}</script>

<hr>
`;

const MOCK_INPUT_WITH_ALT_END = `<!-- ============================================================ -->
<!-- X-0007: AI検索向けFAQ テスト用ヘッダー -->
<!-- ============================================================ -->

<!-- ============================================================ -->
<!-- ページ1: 代替終端 -->
/* スラッグ: /booth/faq/alt-end-test/ -->
<!-- ============================================================ -->

<h2>代替終端テスト</h2>
<p>回答</p>
<script type="application/ld+json">{"@type":"FAQPage"}</script>

<hr>
`;

test('split-faq-pages: 入力ファイルが存在しない場合のエラー処理', () => {
  const result = main('/invalid/non_existent_path.html', '/tmp/out');
  assert.equal(result, null);
});

test('parsePages: 空の文字列を渡すと空配列を返す', () => {
  const result = parsePages('');
  assert.deepEqual(result, []);
});

test('parsePages: ヘッダーのみの入力は0ページ', () => {
  const headerOnly = `<!-- ============================================================ -->
<!-- ヘッダーオンリー -->
<!-- ============================================================ -->`;
  const result = parsePages(headerOnly);
  assert.deepEqual(result, []);
});

test('parsePages: 分割数が20ページであることを確認', () => {
  assert(fs.existsSync(INPUT_FILE), '入力ファイルが存在すること');
  const raw = fs.readFileSync(INPUT_FILE, 'utf-8');
  const result = parsePages(raw);
  assert.equal(result.length, 20);
});

test('parsePages: 各ファイルの本文先頭が <h2> で始まることを確認', () => {
  assert(fs.existsSync(INPUT_FILE), '入力ファイルが存在すること');
  const raw = fs.readFileSync(INPUT_FILE, 'utf-8');
  const result = parsePages(raw);
  for (const page of result) {
    assert(
      page.content.startsWith('<h2>'),
      `本文の先頭が <h2> で始まること: ${page.filename}`,
    );
  }
});

test('parsePages: 各ファイルに <script type="application/ld+json"> が含まれることを確認', () => {
  assert(fs.existsSync(INPUT_FILE), '入力ファイルが存在すること');
  const raw = fs.readFileSync(INPUT_FILE, 'utf-8');
  const result = parsePages(raw);
  for (const page of result) {
    assert(
      page.content.includes('<script type="application/ld+json">'),
      `JSON-LD を含むこと: ${page.filename}`,
    );
  }
});

test('split-faq-pages: 出力ディレクトリが自動作成されることを確認', () => {
  const tempOutputDir = path.join(__dirname, `temp_split_test_${Date.now()}`);
  try {
    assert(!fs.existsSync(tempOutputDir), '作成前は存在しないこと');
    const result = main(INPUT_FILE, tempOutputDir);
    assert(fs.existsSync(tempOutputDir), '出力ディレクトリが自動作成されること');
    assert.equal(result.length, 20);
  } finally {
    if (fs.existsSync(tempOutputDir)) {
      fs.rmSync(tempOutputDir, { recursive: true, force: true });
    }
  }
});

test('parsePages: 3ページを正しく分割する', () => {
  const result = parsePages(MOCK_INPUT);
  assert.equal(result.length, 3);
});

test('parsePages: ファイル名が正しい命名規則に従う', () => {
  const result = parsePages(MOCK_INPUT);
  assert.equal(result[0].filename, 'faq-01-test-page-one.html');
  assert.equal(result[1].filename, 'faq-02-test-page-two.html');
  assert.equal(result[2].filename, 'faq-03-test-page-three.html');
});

test('parsePages: スラッグが正しく抽出される', () => {
  const result = parsePages(MOCK_INPUT);
  assert.equal(result[0].slug, 'test-page-one');
  assert.equal(result[1].slug, 'test-page-two');
  assert.equal(result[2].slug, 'test-page-three');
});

test('parsePages: WordPressヘッダーが含まれ、DOCTYPEなし', () => {
  const result = parsePages(MOCK_INPUT);
  assert(result[0].content.startsWith('<h2>'));
  assert(result[0].content.includes('<!-- X-0007: WordPress固定ページ本文 -->'));
  assert(!result[0].content.includes('<!DOCTYPE html>'));
});

test('parsePages: `-->` で終わるスラッグも正しく抽出できる', () => {
  const result = parsePages(MOCK_INPUT_WITH_ALT_END);
  assert.equal(result.length, 1);
  assert.equal(result[0].slug, 'alt-end-test');
});
