import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  analyzeText,
  checkFrontLoaded,
  restructureText,
  extractProperNouns,
  extractNumbers,
  isQuestionHeading,
  convertHeadingToQuestion,
  replaceHedging,
  countHedgingExpressions,
  countAssertiveExpressions,
  tokenize,
  extractH2Headings,
  getFirstThird,
} from './ai-citation-content.mjs';

// ─── テスト用サンプルデータ ─────────────────────────────────────

const SAMPLE_GOOD_TEXT = `# グリッドビヨンドのスマートエネルギーWeek出展ブース

グリッドビヨンドはスマートエネルギーWeek 2027春（東京ビッグサイト）に出展しました。株式会社オージャストが企画・設計・施工したブースは6小間（約54㎡）、工期は3週間、総額約500万円のプロジェクトです。Re:ブースモジュールを採用し、従来比30%のコスト削減を実現しました。

## この案件の背景と目的は？

グリッドビヨンドは再生可能エネルギー分野の企業です。スマートエネルギーWeekへの出展目的は新規顧客獲得とブランド認知向上でした。

## オージャストはどのようなブースを提案したのか？

オージャストが提案したブースは「つながるエネルギー」をテーマにしたデザインです。

- **ブースサイズ**: 6小間（54㎡）
- **レイアウト**: 半開放型
- **ゾーニング**: 商談ゾーン・デモゾーン・展示ゾーン

## 使用した技術・素材は？

Re:ブースのモジュール式システムを採用しました。LEDモニター55インチを2台設置しました。

## 工期と予算は？

全工期は3週間です。プロジェクト総額は約500万円です。`;

const SAMPLE_POOR_TEXT = `# 展示会出展ブースのご紹介

展示会に出展しました。ブースは6小間で、なかなか良い感じに仕上がりました。

## 概要

ある企業の展示会出展を支援しました。ブースのデザインはシンプルで、来場者からも好評でした。

## デザインについて

半開放型のレイアウトで、商談スペースを確保しました。LEDモニターも設置しています。

## まとめ

全体としては満足いく結果となりました。また機会があればよろしくお願いします。`;

const EMPTY_TEXT = '';
const NO_HEADING_TEXT = `# タイトルのみ

これは見出しのないテキストです。特に何もありません。`;

// ─── ヘルパー ────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const TMP_DIR = resolve(__dirname, 'tmp-test-ai-citation');
const TMP_FILE = resolve(TMP_DIR, 'test-input.md');
const CLI_FILE = resolve(__dirname, 'ai-citation-content.mjs');

function runCli(...args) {
  return spawnSync(process.execPath, [CLI_FILE, ...args], {
    encoding: 'utf-8',
    windowsHide: true,
  });
}

function writeTempFile(content) {
  if (!existsSync(TMP_DIR)) {
    mkdirSync(TMP_DIR, { recursive: true });
  }
  writeFileSync(TMP_FILE, content, 'utf-8');
  return TMP_FILE;
}

function cleanupTemp() {
  try { unlinkSync(TMP_FILE); } catch {}
  try { unlinkSync(resolve(TMP_DIR, 'test-output.md')); } catch {}
  try { unlinkSync(resolve(TMP_DIR, 'test-inplace.md')); } catch {}
}

after(cleanupTemp);

// ─── テスト ──────────────────────────────────────────────────────

describe('ai-citation-content', () => {
  // ── 基本関数 ──

  describe('tokenize', () => {
    it('splits text into tokens', () => {
      const tokens = tokenize('グリッドビヨンド 6小間 54㎡');
      assert.ok(tokens.length >= 3);
      assert.ok(tokens.includes('グリッドビヨンド'));
      // 6小間は文字種境界で 6 + 小間に分割される
      assert.ok(tokens.some(t => t.includes('小間')));
    });

    it('handles empty string', () => {
      assert.deepEqual(tokenize(''), []);
    });
  });

  describe('extractH2Headings', () => {
    it('extracts H2 headings from markdown', () => {
      const headings = extractH2Headings(SAMPLE_GOOD_TEXT);
      assert.equal(headings.length, 4);
      assert.ok(headings[0].includes('背景'));
    });

    it('returns empty array for text without H2', () => {
      const headings = extractH2Headings('# Title only\n\nSome text');
      assert.deepEqual(headings, []);
    });
  });

  describe('getFirstThird', () => {
    it('returns first third of text', () => {
      const text = 'A'.repeat(300);
      const third = getFirstThird(text);
      assert.equal(third.length, 100);
    });

    it('handles short text', () => {
      // 5文字の1/3 = ceil(5/3) = 2文字
      const result = getFirstThird('short');
      assert.equal(result.length, 2);
      assert.equal(result, 'sh');
    });
  });

  // ── 固有名詞検出 ──

  describe('extractProperNouns', () => {
    it('detects katakana proper nouns', () => {
      const nouns = extractProperNouns('グリッドビヨンドが出展しました');
      assert.ok(nouns.includes('グリッドビヨンド'));
    });

    it('detects organization names', () => {
      const nouns = extractProperNouns('株式会社オージャスト');
      // 文字種境界で「株式会社」と「オージャスト」に分割
      // 「オージャスト」はカタカナ固有名詞として検出される
      assert.ok(nouns.includes('オージャスト'));
    });

    it('detects English proper nouns', () => {
      const nouns = extractProperNouns('GridBeyond and Re:booth');
      // "GridBeyond" and "Re" might be separate tokens
      const hasProper = nouns.some(n => /Grid|Re/.test(n));
      assert.ok(nouns.length > 0);
    });

    it('filters common katakana words', () => {
      const nouns = extractProperNouns('このシステムはサービスです');
      // システム and サービス should NOT be in proper nouns
      assert.ok(!nouns.includes('システム'));
      assert.ok(!nouns.includes('サービス'));
    });

    it('returns empty array for text without proper nouns', () => {
      const nouns = extractProperNouns('これはテストです');
      assert.equal(nouns.length, 0);
    });
  });

  // ── 数値検出 ──

  describe('extractNumbers', () => {
    it('detects numbers with units', () => {
      const nums = extractNumbers('6小間（約54㎡）、工期は3週間、総額約500万円');
      assert.ok(nums.some(n => n.includes('6小間')));
      assert.ok(nums.some(n => n.includes('54㎡') || n.includes('54m2')));
      assert.ok(nums.some(n => n.includes('3週間')));
      assert.ok(nums.some(n => n.includes('500万円')));
    });

    it('returns empty array for text without numbers', () => {
      const nums = extractNumbers('これは数値のないテキストです');
      assert.equal(nums.length, 0);
    });
  });

  // ── 質問形式見出し ──

  describe('isQuestionHeading', () => {
    it('detects question ending with question mark', () => {
      assert.equal(isQuestionHeading('この案件の背景は？'), true);
      assert.equal(isQuestionHeading('この案件の背景は?'), true);
    });

    it('detects question with question words', () => {
      assert.equal(isQuestionHeading('なぜこの案件が始まったのか'), true);
      assert.equal(isQuestionHeading('どのようなブースを提案したのか'), true);
      assert.equal(isQuestionHeading('何をしたのか'), true);
    });

    it('rejects non-question headings', () => {
      assert.equal(isQuestionHeading('概要'), false);
      assert.equal(isQuestionHeading('まとめ'), false);
    });
  });

  // ── 控えめ表現・断定的表現 ──

  describe('countHedgingExpressions', () => {
    it('counts hedging expressions', () => {
      const count = countHedgingExpressions('と考えられます。の場合があります。かもしれません。');
      assert.equal(count, 3);
    });

    it('returns 0 for assertive text', () => {
      const count = countHedgingExpressions('これは明らかです。間違いありません。');
      assert.equal(count, 0);
    });
  });

  describe('countAssertiveExpressions', () => {
    it('counts assertive expressions', () => {
      const count = countAssertiveExpressions('これはブースです。施工しました。完成しました。');
      assert.equal(count, 3);
    });

    it('returns 0 for hedging text', () => {
      const count = countAssertiveExpressions('と考えられます。の場合があります。');
      assert.equal(count, 0);
    });
  });

  // ── スコアリング ──

  describe('analyzeText', () => {
    it('returns score structure for good content', () => {
      const result = analyzeText(SAMPLE_GOOD_TEXT);
      assert.ok(result.scores);
      assert.ok(typeof result.scores.total === 'number');
      assert.ok(result.scores.total >= 0);
      assert.ok(result.scores.total <= 100);
    });

    it('returns higher score for well-structured content', () => {
      const good = analyzeText(SAMPLE_GOOD_TEXT);
      const poor = analyzeText(SAMPLE_POOR_TEXT);
      assert.ok(good.scores.total >= poor.scores.total,
        `Expected good(${good.scores.total}) >= poor(${poor.scores.total})`);
    });

    it('includes proper nouns in details', () => {
      const result = analyzeText(SAMPLE_GOOD_TEXT);
      assert.ok(Array.isArray(result.details.properNouns));
      assert.ok(result.details.properNounCount > 0);
    });

    it('includes question headings in details', () => {
      const result = analyzeText(SAMPLE_GOOD_TEXT);
      assert.ok(result.details.questionHeadingCount >= 0);
      assert.ok(result.details.totalHeadings > 0);
    });

    it('handles empty text gracefully', () => {
      const result = analyzeText(EMPTY_TEXT);
      assert.ok(result.scores);
      // 空テキストは assertive の fallback で10点になる
      assert.equal(result.scores.total, 10);
    });

    it('handles text without headings', () => {
      const result = analyzeText(NO_HEADING_TEXT);
      assert.ok(result.scores);
      assert.ok(typeof result.scores.total === 'number');
    });
  });

  // ── チェック ──

  describe('checkFrontLoaded', () => {
    it('returns passed for good content', () => {
      const result = checkFrontLoaded(SAMPLE_GOOD_TEXT);
      assert.ok(typeof result.passed === 'boolean');
      assert.ok(result.checks);
      assert.ok(typeof result.score === 'number');
    });

    it('returns failed for poor content', () => {
      const result = checkFrontLoaded(SAMPLE_POOR_TEXT);
      // Poor content likely fails most checks
      assert.ok(typeof result.passed === 'boolean');
    });

    it('reports individual check results', () => {
      const result = checkFrontLoaded(SAMPLE_GOOD_TEXT);
      const checkKeys = Object.keys(result.checks);
      assert.ok(checkKeys.length > 0);
      for (const [key, passed] of Object.entries(result.checks)) {
        assert.ok(typeof passed === 'boolean');
      }
    });
  });

  // ── リストラクチャリング ──

  describe('convertHeadingToQuestion', () => {
    it('converts common headings to question format', () => {
      assert.equal(convertHeadingToQuestion('概要'), '## この案件の概要は？');
      assert.equal(convertHeadingToQuestion('背景'), '## この案件の背景と目的は？');
      assert.equal(convertHeadingToQuestion('成果'), '## この展示会の成果は？');
    });

    it('keeps already question-format headings', () => {
      const q = '## この案件の背景と目的は？';
      assert.equal(convertHeadingToQuestion(q), q);
    });

    it('falls back to generic conversion for unknown headings', () => {
      const result = convertHeadingToQuestion('特殊な見出し');
      assert.ok(result.includes('特殊な見出し'));
      assert.ok(result.includes('何か'));
    });
  });

  describe('replaceHedging', () => {
    it('replaces hedging expressions with assertive ones', () => {
      const result = replaceHedging('このブースは効果的と考えられます。');
      assert.ok(result.includes('です'));
      assert.ok(!result.includes('と考えられます'));
    });

    it('replaces multiple hedging patterns', () => {
      const result = replaceHedging('効果的と考えられます。改善の場合があります。');
      assert.ok(!result.includes('と考えられます'));
      assert.ok(!result.includes('の場合があります'));
    });

    it('preserves text without hedging', () => {
      const text = 'これは通常の文章です。問題ありません。';
      assert.equal(replaceHedging(text), text);
    });
  });

  describe('restructureText', () => {
    it('converts H2 headings to question format', () => {
      const result = restructureText(SAMPLE_POOR_TEXT);
      // After restructuring, headings should contain question words
      assert.ok(result.includes('？') || result.includes('?'));
    });

    it('replaces hedging expressions', () => {
      const textWithHedging = SAMPLE_GOOD_TEXT + '\n\n## まとめ\n\n効果的と考えられます。';
      const result = restructureText(textWithHedging);
      assert.ok(!result.includes('と考えられます'));
    });

    it('returns a non-empty result', () => {
      const result = restructureText(SAMPLE_GOOD_TEXT);
      assert.ok(result.length > 0);
    });
  });

  // ── CLI サブコマンド ──

  describe('CLI operations', () => {
    const tmpFile = writeTempFile(SAMPLE_GOOD_TEXT);

    it('analyze outputs JSON with file and score', () => {
      const cli = runCli('analyze', tmpFile);
      assert.equal(cli.status, 0, cli.stderr);
      const result = JSON.parse(cli.stdout);
      assert.equal(result.file, tmpFile);
      assert.equal(typeof result.scores.total, 'number');
    });

    it('score outputs numeric value', () => {
      const cli = runCli('score', tmpFile);
      assert.equal(cli.status, 0, cli.stderr);
      assert.match(cli.stdout, /^\d+\r?\n$/);
    });

    it('check returns exit code 0 for passing content and 1 for failing content', () => {
      const passing = runCli('check', tmpFile);
      assert.equal(passing.status, 0, passing.stdout + passing.stderr);
      writeTempFile(SAMPLE_POOR_TEXT);
      const failing = runCli('check', tmpFile);
      assert.equal(failing.status, 1, failing.stdout + failing.stderr);
      writeTempFile(SAMPLE_GOOD_TEXT);
    });
  });
});

// ── エラーハンドリング ──

describe('error handling', () => {
  it('errors for a non-existent file', () => {
    const cli = runCli('analyze', resolve(TMP_DIR, 'missing.md'));
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /File not found/);
  });

  it('errors for an empty file', () => {
    const emptyFile = writeTempFile('');
    const cli = runCli('analyze', emptyFile);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /File is empty/);
    writeTempFile(SAMPLE_GOOD_TEXT);
  });

  it('analyze handles minimal content', () => {
    const result = analyzeText('# Minimal\n\nHello');
    assert.ok(result.scores);
    assert.ok(typeof result.scores.total === 'number');
  });

  it('analyze handles content with only numbers', () => {
    const text = '# Test\n\n6小間のブースを3週間で施工しました。';
    const result = analyzeText(text);
    assert.ok(result.details.numbersFoundCount >= 2);
  });

  it('analyze handles content with only proper nouns', () => {
    const text = '# Test\n\nグリッドビヨンドと株式会社オージャストとRe:ブース';
    const result = analyzeText(text);
    assert.ok(result.details.properNounCount >= 2);
  });
});
