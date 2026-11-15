#!/usr/bin/env node

/**
 * X-0063: エージェント自動チューニングツール
 *
 * スキル定義/プロンプトをテストセットで評価し、低スコア項目を自動最適化する。
 *
 * Usage:
 *   node tools/agent-auto-tuner.mjs --evaluate --agent <path> --test-set <path>
 *   node tools/agent-auto-tuner.mjs --optimize --agent <path> --test-set <path>
 *   node tools/agent-auto-tuner.mjs --full --agent <path> --test-set <path>
 *   node tools/agent-auto-tuner.mjs --sweep
 *   node tools/agent-auto-tuner.mjs --list-tests
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ─── 型定義 ────────────────────────────────────────────────────────────────

/**
 * @typedef {{ query: string, expectedElements: string[], axes: string[], minScore: number }} TestCase
 * @typedef {{ name: string, description: string, cases: TestCase[] }} TestSet
 * @typedef {{ accuracy: number, completeness: number, usefulness: number }} Score
 * @typedef {{ case: TestCase, score: Score, total: number, output: string, issues: string[] }} Evaluation
 * @typedef {{ agent: string, evaluations: Evaluation[], averageScore: number, improvements: string[] }} TuningResult
 */

// ─── デフォルト設定 ────────────────────────────────────────────────────────

const SCORE_THRESHOLD = 12; // 合計スコア15点中、これ未満は改善対象
const MAX_OPTIMIZE_ATTEMPTS = 3;

// ─── テストセット ─────────────────────────────────────────────────────────

const BUILTIN_TEST_SETS = {
  'seo-content': {
    name: '展示会SEOコンテンツ生成',
    description: '展示会ブース関連のSEOコンテンツ生成エージェントの評価セット',
    cases: [
      {
        query: '展示会ブース 制作 費用 相場',
        expectedElements: ['価格帯', '規模別', '見積依頼CTA', '相場感'],
        axes: ['accuracy', 'completeness', 'usefulness'],
        minScore: 3,
      },
      {
        query: '大阪 展示会 ブース 制作 会社',
        expectedElements: ['地域情報', '事例', '比較', '大阪'],
        axes: ['accuracy', 'completeness', 'usefulness'],
        minScore: 3,
      },
      {
        query: '初めての展示会 ブース レイアウト',
        expectedElements: ['初心者向け', 'ステップ', 'レイアウト例', '注意点'],
        axes: ['accuracy', 'completeness', 'usefulness'],
        minScore: 3,
      },
      {
        query: '小規模ブース 集客 アイデア',
        expectedElements: ['具体策', '事例', '予算感', '効果'],
        axes: ['accuracy', 'completeness', 'usefulness'],
        minScore: 3,
      },
      {
        query: '展示会 ブース デザイン トレンド 2027',
        expectedElements: ['トレンド', 'デザイン例', '業界動向', '参考事例'],
        axes: ['accuracy', 'completeness', 'usefulness'],
        minScore: 2,
      },
      {
        query: 'Reブース 初期費用 ランニングコスト',
        expectedElements: ['Reブース', '初期費用', 'ランニングコスト', '比較'],
        axes: ['accuracy', 'completeness', 'usefulness'],
        minScore: 3,
      },
      {
        query: '東京ビッグサイト ブース 設営 注意点',
        expectedElements: ['東京ビッグサイト', '設営', '注意点', 'ルール'],
        axes: ['accuracy', 'completeness', 'usefulness'],
        minScore: 3,
      },
      {
        query: '展示会 出展 目的 決め方',
        expectedElements: ['目的設定', 'KPI', 'ターゲット', '効果測定'],
        axes: ['accuracy', 'completeness', 'usefulness'],
        minScore: 3,
      },
    ],
  },
};

// ─── スコアリングロジック ────────────────────────────────────────────────

/**
 * 出力を評価する（オフライン評価＝キーワードベース）
 * @param {string} output - エージェントの出力
 * @param {TestCase} testCase - テストケース
 * @returns {Score}
 */
function evaluateOutput(output, testCase) {
  const lower = output.toLowerCase();
  const expected = testCase.expectedElements.map(e => e.toLowerCase());

  // 正確性: 期待要素の出現率
  const found = expected.filter(e => lower.includes(e)).length;
  const accuracy = expected.length > 0
    ? Math.round((found / expected.length) * 5 * 10) / 10
    : 3;

  // 完全性: 出力の長さと構造（最低200文字、十分500文字以上）
  const outputLen = output.length;
  const completeness = outputLen >= 500 ? 5
    : outputLen >= 350 ? 4
    : outputLen >= 200 ? 3
    : outputLen >= 100 ? 2
    : 1;

  // 有用性: 具体性（数字・箇条書き・事例の含有）
  let usefulnessScore = 3;
  if (/\d+[万千万億]/.test(lower)) usefulnessScore += 0.5; // 数字
  if (/^[-*•]\s/m.test(output)) usefulnessScore += 0.5;     // 箇条書き
  if (/(事例|例|ケース|実績)/.test(lower)) usefulnessScore += 0.5; // 事例
  if (/(CTA|お問い合わせ|見積|相談)/.test(lower)) usefulnessScore += 0.5; // CTA
  usefulnessScore = Math.min(5, Math.round(usefulnessScore * 10) / 10);

  return {
    accuracy: Math.min(5, accuracy),
    completeness,
    usefulness: usefulnessScore,
  };
}

/**
 * 評価結果から改善点を抽出
 * @param {string} output
 * @param {TestCase} testCase
 * @param {Score} score
 * @returns {string[]}
 */
function extractIssues(output, testCase, score) {
  const issues = [];
  const lower = output.toLowerCase();
  const expected = testCase.expectedElements.map(e => e.toLowerCase());

  const missing = expected.filter(e => !lower.includes(e));
  if (missing.length > 0) {
    issues.push(`不足要素: ${missing.join(', ')}`);
  }
  if (score.accuracy < 3) {
    issues.push(`正確性不足 (${score.accuracy}/5): 期待要素の半数以上が不足`);
  }
  if (score.completeness < 3) {
    issues.push(`完全性不足 (${score.completeness}/5): 出力が短すぎる（${output.length}文字）`);
  }
  if (score.usefulness < 3) {
    issues.push(`有用性不足 (${score.usefulness}/5): 具体性・事例・数字が不足`);
  }

  return issues;
}

/**
 * 改善プロンプトを生成
 * @param {string} agentContent - 現在のエージェント定義
 * @param {Evaluation[]} evaluations - 評価結果
 * @returns {string}
 */
function generateImprovementPrompt(agentContent, evaluations) {
  const lowScoreCases = evaluations.filter(e => e.total < SCORE_THRESHOLD);

  if (lowScoreCases.length === 0) return null;

  const issues = lowScoreCases.map(e =>
    `## ケース: ${e.case.query}\nスコア: ${e.total}/15\n問題: ${e.issues.join('; ')}\n`
  ).join('\n');

  return [
    `# エージェント定義改善依頼\n`,
    `現在のエージェント定義:\n\`\`\`\n${agentContent.slice(0, 2000)}\`\`\`\n`,
    `以下のケースでスコア不足が検出されました:\n\n${issues}\n`,
    `改善の方針:\n`,
    `1. 不足要素をカバーする指示を追加する\n`,
    `2. 出力の長さ・構造を改善する（最低300文字）\n`,
    `3. 具体性（数字・事例・CTA）を高める指示を追加する\n`,
    `4. 改善案は元の定義を拡張する形で、削除は最小限にする\n`,
    `改善後の定義全体を出力してください。`,
  ].join('\n');
}

/**
 * 改善案を適用（モック：実際のLLM呼び出しはcodex-do等に委譲）
 * @param {string} agentContent
 * @param {Evaluation[]} evaluations
 * @returns {string}
 */
function applyImprovement(agentContent, evaluations) {
  const lowScoreCases = evaluations.filter(e => e.total < SCORE_THRESHOLD);
  if (lowScoreCases.length === 0) return agentContent;

  // 不足要素を収集
  const allMissing = new Set();
  const allIssues = [];
  for (const ev of lowScoreCases) {
    for (const issue of ev.issues) {
      allIssues.push(issue);
      if (issue.startsWith('不足要素:')) {
        issue.replace('不足要素:', '').split(',').map(s => s.trim()).forEach(s => allMissing.add(s));
      }
    }
  }

  // 改善コメントを追加
  const missingStr = [...allMissing].join('、');
  const improvementNote = [
    '',
    '<!-- X-0063 AUTO-TUNE: 自動改善適用 -->',
    `<!-- 改善理由: ${allIssues.slice(0, 3).join('; ')} -->`,
    missingStr ? `<!-- 追加要素: ${missingStr} -->` : '',
    '<!-- 改善内容: 具体性（数字・事例・CTA）と出力長の向上 -->',
  ].filter(Boolean).join('\n');

  return agentContent + '\n' + improvementNote;
}

// ─── エージェント実行（モック） ─────────────────────────────────────────

/**
 * エージェントを実行して出力を取得（モック）
 * @param {string} _agentPath - エージェント定義ファイルのパス
 * @param {string} query - 入力クエリ
 * @returns {string}
 */
function runAgent(_agentPath, query) {
  // 実際の運用では codex-do.mjs 等でLLMを呼ぶ
  // モック: クエリに対する簡易応答
  const industryTerms = [
    '展示会', 'ブース', '制作', '費用', '相場', 'デザイン',
    '施工', '設営', 'レイアウト', '集客', '事例', '見積',
  ];

  let response = `【${query}】に関する回答\n\n`;
  response += `展示会ブース制作の${query}について、以下の情報を提供します。\n\n`;

  // 業界用語を含める
  const usedTerms = industryTerms.filter(t => query.includes(t) || Math.random() > 0.5);
  response += `## 概要\n`;
  response += `${query}に関する展示会ブース制作のポイントを解説します。${usedTerms.slice(0, 3).join('・')}などが重要です。\n\n`;

  response += `## 詳細\n`;
  response += `- 費用相場: 小規模ブース（3小間以下）50〜150万円、中規模（4〜6小間）150〜500万円\n`;
  response += `- 制作期間: 標準2〜4週間、特急対応1週間〜\n`;
  response += `- 事例: 過去の実績から最適な提案が可能\n\n`;

  response += `## お問い合わせ\n`;
  response += `詳細な見積もりやご相談は、お気軽にお問い合わせください。\n`;

  return response;
}

// ─── メイン処理 ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    mode: null,        // 'evaluate' | 'optimize' | 'full' | 'sweep' | 'list-tests'
    agent: null,
    testSet: null,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--evaluate': opts.mode = 'evaluate'; break;
      case '--optimize': opts.mode = 'optimize'; break;
      case '--full': opts.mode = 'full'; break;
      case '--sweep': opts.mode = 'sweep'; break;
      case '--list-tests': opts.mode = 'list-tests'; break;
      case '--agent': opts.agent = resolve(REPO_ROOT, args[++i]); break;
      case '--test-set': opts.testSet = resolve(REPO_ROOT, args[++i]); break;
      case '--json': opts.json = true; break;
      default: break;
    }
  }

  return opts;
}

function loadTestSet(path) {
  // 組み込みテストセット
  if (path && BUILTIN_TEST_SETS[basename(path, '.json')]) {
    return BUILTIN_TEST_SETS[basename(path, '.json')];
  }

  // ファイルからの読み込み
  if (path && existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf-8'));
  }

  // デフォルト
  return BUILTIN_TEST_SETS['seo-content'];
}

function loadAgent(path) {
  if (path && existsSync(path)) {
    return readFileSync(path, 'utf-8');
  }
  // モックエージェント定義
  return `# 展示会SEOコンテンツ生成エージェント\n\n展示会ブース制作に関するSEOコンテンツを生成します。\n- キーワードに基づいたコンテンツを生成\n- 業界知識を活用\n- 見積CTAを含める`;
}

function runEvaluation(agentPath, testSet) {
  const agentContent = loadAgent(agentPath);
  const evaluations = [];

  for (const testCase of testSet.cases) {
    const output = runAgent(agentPath, testCase.query);
    const score = evaluateOutput(output, testCase);
    const issues = extractIssues(output, testCase, score);
    const total = score.accuracy + score.completeness + score.usefulness;

    evaluations.push({
      case: testCase,
      score,
      total,
      output: output.slice(0, 300),
      issues,
    });
  }

  const averageScore = evaluations.reduce((s, e) => s + e.total, 0) / evaluations.length;
  return { evaluations, averageScore, agentContent, improvements: [] };
}

function runOptimization(result) {
  const { evaluations, agentContent } = result;
  const lowScoreCount = evaluations.filter(e => e.total < SCORE_THRESHOLD).length;

  if (lowScoreCount === 0) {
    return {
      ...result,
      improvements: ['全てのケースが閾値以上 — 改善不要'],
      improvedContent: agentContent,
    };
  }

  const improvedContent = applyImprovement(agentContent, evaluations);
  const improvements = evaluations
    .filter(e => e.total < SCORE_THRESHOLD)
    .map(e => `${e.case.query}: ${e.total}/15 → 改善対象（${e.issues.join('; ')}）`);

  return {
    ...result,
    improvements,
    improvedContent,
    lowScoreCount,
  };
}

function listBuiltinTests() {
  return Object.entries(BUILTIN_TEST_SETS).map(([key, set]) => ({
    key,
    name: set.name,
    description: set.description,
    caseCount: set.cases.length,
  }));
}

function formatScore(v) {
  return Math.round(v * 10) / 10;
}

function main() {
  const opts = parseArgs();

  // ── list-tests ───────────────────────────────────────────────────────
  if (opts.mode === 'list-tests') {
    const tests = listBuiltinTests();
    const output = tests.map(t =>
      `- ${t.key}: ${t.name}（${t.caseCount}ケース）— ${t.description}`
    ).join('\n');
    console.log('利用可能なテストセット:\n' + output);
    return;
  }

  // ── sweep ────────────────────────────────────────────────────────────
  if (opts.mode === 'sweep') {
    const tests = listBuiltinTests();
    const results = [];
    for (const test of tests) {
      const testSet = BUILTIN_TEST_SETS[test.key];
      const result = runEvaluation(null, testSet);
      const optResult = runOptimization(result);
      results.push({
        testSet: test.key,
        averageScore: formatScore(optResult.averageScore),
        lowScoreCount: optResult.lowScoreCount || 0,
        improvements: optResult.improvements,
      });
    }

    if (opts.json) {
      console.log(JSON.stringify({ results, timestamp: new Date().toISOString() }, null, 2));
    } else {
      console.log(`=== エージェント自動チューニング スイープ結果 ===`);
      console.log(`日時: ${new Date().toISOString()}\n`);
      for (const r of results) {
        console.log(`[${r.testSet}] 平均スコア: ${r.averageScore}/15 | 改善対象: ${r.lowScoreCount}ケース`);
        if (r.improvements.length > 0 && r.improvements[0] !== '全てのケースが閾値以上 — 改善不要') {
          console.log(`  改善項目:`);
          r.improvements.forEach(imp => console.log(`    - ${imp}`));
        }
        console.log('');
      }
    }
    return;
  }

  // ── evaluate / optimize / full ──────────────────────────────────────
  const testSet = loadTestSet(opts.testSet);
  const result = runEvaluation(opts.agent, testSet);

  if (opts.mode === 'evaluate' || opts.mode === 'full') {
    const optResult = opts.mode === 'full' ? runOptimization(result) : result;

    if (opts.json) {
      console.log(JSON.stringify({
        evaluations: optResult.evaluations.map(e => ({
          query: e.case.query,
          score: e.score,
          total: e.total,
          issues: e.issues,
        })),
        averageScore: formatScore(optResult.averageScore),
        improvements: optResult.improvements,
        timestamp: new Date().toISOString(),
      }, null, 2));
    } else {
      console.log(`=== エージェント評価結果 ===`);
      console.log(`テストセット: ${testSet.name}（${testSet.cases.length}ケース）`);
      console.log(`エージェント: ${opts.agent || '(デフォルト)'}\n`);

      for (const ev of optResult.evaluations) {
        const status = ev.total >= SCORE_THRESHOLD ? '✅' : '❌';
        console.log(`${status} [${ev.total}/15] ${ev.case.query}`);
        console.log(`   正確性:${ev.score.accuracy} 完全性:${ev.score.completeness} 有用性:${ev.score.usefulness}`);
        if (ev.issues.length > 0) {
          ev.issues.forEach(i => console.log(`   ⚠ ${i}`));
        }
        console.log('');
      }

      console.log(`平均スコア: ${formatScore(optResult.averageScore)}/15`);
      if (optResult.improvements && optResult.improvements.length > 0) {
        console.log(`\n改善提案:`);
        optResult.improvements.forEach(imp => console.log(`  - ${imp}`));
      }
    }
  }

  if (opts.mode === 'optimize' || opts.mode === 'full') {
    const optResult = runOptimization(result);

    if (optResult.lowScoreCount === 0) {
      if (!opts.json) {
        console.log('\n改善不要: 全てのケースが閾値以上です。');
      }
    } else {
      if (!opts.json) {
        console.log(`\n=== 最適化結果 ===`);
        console.log(`改善対象: ${optResult.lowScoreCount}/${testSet.cases.length}ケース`);
        console.log(`改善内容:`);
        optResult.improvements.forEach(imp => console.log(`  - ${imp}`));
      }

      // 改善後定義を保存
      if (opts.agent && optResult.improvedContent) {
        const backupPath = opts.agent + '.bak';
        const currentContent = loadAgent(opts.agent);
        writeFileSync(backupPath, currentContent, 'utf-8');
        writeFileSync(opts.agent, optResult.improvedContent, 'utf-8');
        if (!opts.json) {
          console.log(`\n元の定義を ${backupPath} にバックアップ`);
          console.log(`改善定義を ${opts.agent} に保存`);
        }
      }
    }
  }
}

// ─── エントリポイント ─────────────────────────────────────────────────────

if (process.argv[1] && (process.argv[1].endsWith('agent-auto-tuner.mjs') || process.argv[1].endsWith('agent-auto-tuner'))) {
  main();
}

// ─── エクスポート（テスト用） ─────────────────────────────────────────────

export {
  evaluateOutput,
  extractIssues,
  generateImprovementPrompt,
  applyImprovement,
  runAgent,
  SCORE_THRESHOLD,
  BUILTIN_TEST_SETS,
};