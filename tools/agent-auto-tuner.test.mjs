import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  evaluateOutput,
  extractIssues,
  generateImprovementPrompt,
  applyImprovement,
  SCORE_THRESHOLD,
  BUILTIN_TEST_SETS,
} from './agent-auto-tuner.mjs';

const TOOL = fileURLToPath(new URL('agent-auto-tuner.mjs', import.meta.url));

function run(...args) {
  const stdout = execFileSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf-8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout.trim();
}

function runWithStderr(...args) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL, ...args], {
      encoding: 'utf-8',
      maxBuffer: 4 * 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: '' };
  } catch (e) {
    return {
      stdout: e.stdout ? e.stdout.trim() : '',
      stderr: e.stderr ? e.stderr.trim() : '',
    };
  }
}

describe('agent-auto-tuner', () => {

  // ── CLI tests ─────────────────────────────────────────────────────────

  it('--list-tests が空でないテスト一覧を返す', () => {
    const out = run('--list-tests');
    assert.ok(out.length > 0, '出力が空');
    assert.ok(out.includes('seo-content'), 'seo-content テストセットを含む');
  });

  it('--evaluate が評価結果を返す', () => {
    const out = run('--evaluate');
    assert.ok(out.includes('評価結果'), '評価結果ヘッダを含む');
    assert.ok(out.includes('/15]'), 'スコア表記を含む');
    assert.ok(out.includes('平均スコア'), '平均スコアを含む');
  });

  it('--full が評価＋改善提案を返す', () => {
    const out = run('--full');
    assert.ok(out.includes('評価結果'), '評価結果ヘッダを含む');
    assert.ok(out.includes('改善提案') || out.includes('改善不要'), '改善セクションを含む');
  });

  it('--sweep が全テストセットの結果を返す', () => {
    const out = run('--sweep');
    assert.ok(out.includes('スイープ結果'), 'スイープヘッダを含む');
    assert.ok(out.includes('平均スコア'), '平均スコアを含む');
  });

  it('--json フラグでJSON出力される', () => {
    const out = run('--evaluate', '--json');
    assert.ok(out.startsWith('{'), 'JSONオブジェクトで始まる');
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.evaluations), 'evaluations が配列');
    assert.ok(typeof parsed.averageScore === 'number', 'averageScore が数値');
    assert.ok(parsed.timestamp, 'timestamp を含む');
  });

  // ── Core logic tests ──────────────────────────────────────────────────

  it('evaluateOutput が正しいスコア構造を返す', () => {
    const output = '展示会ブース制作の費用相場について解説します。小規模ブースは50〜150万円です。';
    const testCase = {
      query: '展示会ブース 費用 相場',
      expectedElements: ['費用', '相場', 'ブース'],
      axes: ['accuracy', 'completeness', 'usefulness'],
      minScore: 3,
    };

    const score = evaluateOutput(output, testCase);
    assert.ok(typeof score.accuracy === 'number', 'accuracy が数値');
    assert.ok(typeof score.completeness === 'number', 'completeness が数値');
    assert.ok(typeof score.usefulness === 'number', 'usefulness が数値');
    assert.ok(score.accuracy >= 1 && score.accuracy <= 5, `accuracy が範囲内: ${score.accuracy}`);
    assert.ok(score.completeness >= 1 && score.completeness <= 5, `completeness が範囲内: ${score.completeness}`);
    assert.ok(score.usefulness >= 1 && score.usefulness <= 5, `usefulness が範囲内: ${score.usefulness}`);
  });

  it('evaluateOutput が期待要素を含む出力に高い正確性スコアを付ける', () => {
    const output = '展示会ブースの費用相場は50万〜150万円です。ブースのレイアウトについても解説します。見積もりはお問い合わせください。';
    const testCase = {
      query: '展示会ブース 費用 相場',
      expectedElements: ['費用', '相場', 'ブース', '見積'],
      axes: ['accuracy', 'completeness', 'usefulness'],
      minScore: 3,
    };

    const score = evaluateOutput(output, testCase);
    assert.ok(score.accuracy >= 3, `高い正確性スコア: ${score.accuracy}`);
  });

  it('extractIssues が不足要素を検出する', () => {
    const output = '展示会についての簡単な説明です。';
    const testCase = {
      query: '展示会ブース 費用 相場',
      expectedElements: ['費用', '相場', 'ブース', '見積', '事例'],
      axes: ['accuracy', 'completeness', 'usefulness'],
      minScore: 3,
    };
    const score = evaluateOutput(output, testCase);
    const issues = extractIssues(output, testCase, score);

    assert.ok(issues.length > 0, '課題が検出される');
    assert.ok(issues.some(i => i.includes('不足要素')), '不足要素の課題を含む');
  });

  it('applyImprovement が低スコアケースに改善を適用する', () => {
    const agentContent = '# テストエージェント\n簡単な説明';
    const evaluations = [
      {
        case: { query: 'テストクエリ', expectedElements: ['A', 'B'], axes: ['accuracy'], minScore: 3 },
        score: { accuracy: 1, completeness: 1, usefulness: 1 },
        total: 3,
        issues: ['不足要素: A, B', '正確性不足'],
        output: '短い出力',
      },
    ];

    const improved = applyImprovement(agentContent, evaluations);
    assert.ok(improved.includes('AUTO-TUNE'), '改善マーカーを含む');
    assert.ok(improved.includes('改善理由'), '改善理由を含む');
    assert.ok(improved.length > agentContent.length, '改善後の内容が長い');
  });

  it('generateImprovementPrompt が低スコアケースがある場合にプロンプトを生成する', () => {
    const evaluations = [
      {
        case: { query: '低スコアクエリ', expectedElements: ['A'], axes: ['accuracy'], minScore: 3 },
        score: { accuracy: 1, completeness: 1, usefulness: 1 },
        total: 3,
        issues: ['不足要素: A'],
        output: '短い',
      },
    ];

    const prompt = generateImprovementPrompt('# テスト', evaluations);
    assert.ok(prompt, 'プロンプトが生成される');
    assert.ok(prompt.includes('低スコアクエリ'), '低スコアクエリ名を含む');
    assert.ok(prompt.includes('改善後の定義'), '改善指示を含む');
  });

  it('generateImprovementPrompt が全ケース高スコアならnullを返す', () => {
    const evaluations = [
      {
        case: { query: '高スコアクエリ', expectedElements: ['A'], axes: ['accuracy'], minScore: 3 },
        score: { accuracy: 5, completeness: 5, usefulness: 5 },
        total: 15,
        issues: [],
        output: '十分な長さの出力です。'.repeat(50),
      },
    ];

    const prompt = generateImprovementPrompt('# テスト', evaluations);
    assert.strictEqual(prompt, null);
  });

  it('BUILTIN_TEST_SETS が seo-content テストセットを含む', () => {
    assert.ok(BUILTIN_TEST_SETS['seo-content'], 'seo-content テストセットが存在');
    assert.ok(BUILTIN_TEST_SETS['seo-content'].cases.length >= 5, '5ケース以上含む');
    assert.ok(BUILTIN_TEST_SETS['seo-content'].cases.every(c => c.query && c.expectedElements), '各ケースが必要フィールドを持つ');
  });

  it('SCORE_THRESHOLD が定義されている', () => {
    assert.strictEqual(typeof SCORE_THRESHOLD, 'number');
    assert.ok(SCORE_THRESHOLD > 0);
  });

  // ── エッジケース ──────────────────────────────────────────────────────

  it('空の出力で正しく評価される', () => {
    const score = evaluateOutput('', {
      query: 'テスト',
      expectedElements: ['A', 'B'],
      axes: ['accuracy'],
      minScore: 3,
    });
    assert.ok(score.accuracy <= 2, '空出力の正確性は低い');
    assert.strictEqual(score.completeness, 1, '空出力の完全性は1');
  });

  it('空の expectedElements でエラーにならない', () => {
    const score = evaluateOutput('何らかの出力', {
      query: 'テスト',
      expectedElements: [],
      axes: ['accuracy'],
      minScore: 3,
    });
    assert.strictEqual(typeof score.accuracy, 'number');
    assert.ok(score.accuracy >= 1 && score.accuracy <= 5);
  });

  it('--list-tests がJSON出力できる', () => {
    const out = run('--sweep', '--json');
    assert.ok(out.startsWith('{'), 'JSONで始まる');
    const parsed = JSON.parse(out);
    assert.ok(Array.isArray(parsed.results), 'results が配列');
    assert.ok(parsed.timestamp, 'timestamp を含む');
  });
});