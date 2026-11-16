#!/usr/bin/env node
/**
 * code-improve-plan.mjs — 強AI計画＋安AI実行のコード改善パイプライン
 *
 * Phase 1: 強AI (Fable/Opus) がコード差分を点検し構造化タスク計画を生成
 * Phase 2: 安AI (Codex/Gemini) が計画に従って実装
 * Phase 3: 検証（テスト実行＋計画充足チェック）
 *
 * 使い方:
 *   node tools/code-improve-plan.mjs [options]
 *
 * オプション:
 *   --diff <text>        レビュー対象の差分テキスト（省略時は git diff）
 *   --target <file>      単一ファイルを指定（git diff HEAD -- <file>）
 *   --plan-only          Phase 1（計画生成）で停止
 *   --dry-run            API呼び出しせず計画案のみ表示
 *   --verify-only <json> 既存計画の実行結果を検証（Phase 3のみ）
 *   --max-tasks <n>      最大タスク数（既定: 8）
 *   --lane <name>        実装レーン指定（codex / gemini / groq、既定: codex）
 *   --cwd <path>         作業ディレクトリ（既定: リポジトリルート）
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

// ─── 型定義 ────────────────────────────────────────────

/** @typedef {{ planId: string, target: { files: string[], diffSummary: string }, tasks: Task[], verification: string[], cost: { estimatedTokens: number, preferredLane: string } }} ImprovementPlan */

/**
 * @typedef {{ id: string, title: string, file: string, line: number, description: string, expectedChange: string, testRequired: boolean, status?: 'pending'|'done'|'failed'|'skipped' }} Task */

// ─── CLI引数解析 ────────────────────────────────────────

function parseArgs(argv) {
  const args = { maxTasks: 8, lane: 'codex', cwd: REPO_ROOT };
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--diff': args.diff = argv[++i]; break;
      case '--target': args.target = argv[++i]; break;
      case '--plan-only': args.planOnly = true; break;
      case '--dry-run': args.dryRun = true; break;
      case '--verify-only': args.verifyOnly = argv[++i]; break;
      case '--max-tasks': args.maxTasks = parseInt(argv[++i], 10) || 8; break;
      case '--lane': args.lane = argv[++i]; break;
      case '--cwd': args.cwd = path.resolve(argv[++i]); break;
      default: break;
    }
  }
  return args;
}

// ─── Git diff 取得 ─────────────────────────────────────

function getGitDiff(cwd, targetFile) {
  const args = ['-C', cwd, 'diff'];
  if (targetFile) args.push('HEAD', '--', targetFile);
  const result = spawnSync('git', args, { encoding: 'utf8', cwd, windowsHide: true });
  if (result.error) {
    console.error('git diff 失敗:', result.error.message);
    process.exit(1);
  }
  const diff = result.stdout.trim();
  if (!diff) {
    console.log('変更がありません。改善対象の差分がありません。');
    process.exit(0);
  }
  return diff;
}

function getDiffStat(cwd) {
  const result = spawnSync('git', ['-C', cwd, 'diff', '--stat'], { encoding: 'utf8', cwd, windowsHide: true });
  return result.stdout.trim();
}

// ─── Phase 1: 強AIコード点検＋計画生成 ────────────────

function generateReviewPrompt(diff, diffStat, maxTasks) {
  return `あなたは熟練したコードレビューア（Fable 5.1）です。
以下のコード差分を点検し、改善すべき問題を特定して構造化タスク計画を生成してください。

## コード差分
\`\`\`
${diffStat}

${diff.slice(0, 8000)}
\`\`\`

## 指示
1. コードの問題点（バグ・非効率・スタイル・セキュリティ・テスト不足）を特定
2. 各問題を1つのタスクに分解（最大${maxTasks}件）
3. 各タスクに以下の情報を含める:
   - id: T1, T2, ... の連番
   - title: 簡潔なタイトル
   - file: 対象ファイルパス
   - line: おおよその行番号
   - description: 何をどう直すか（具体的に）
   - expectedChange: 期待される変更内容
   - testRequired: テスト要否（true/false）
4. 検証項目リスト（verification）も作成

## 出力形式
以下のJSONのみを出力してください（説明や注釈は一切含めない）:

\`\`\`json
{
  "planId": "improve-YYYYMMDD-XXX",
  "target": {
    "files": ["file1.ts", "file2.ts"],
    "diffSummary": "簡潔な変更概要"
  },
  "tasks": [
    {
      "id": "T1",
      "title": "タスクタイトル",
      "file": "file1.ts",
      "line": 123,
      "description": "具体的な修正内容",
      "expectedChange": "期待されるコード変更",
      "testRequired": true
    }
  ],
  "verification": ["検証項目1", "検証項目2"],
  "cost": {
    "estimatedTokens": 5000,
    "preferredLane": "codex"
  }
}
\`\`\`
`;
}

function callStrongAi(prompt, { dryRun = false } = {}) {
  if (dryRun) {
    console.log('=== [DRY RUN] 強AIに送信するプロンプト ===');
    console.log(prompt.slice(0, 500) + '...');
    return getDryRunPlan();
  }

  // 強AI呼び出し: codex-do の --kind investigate で Fable/Opus 相当に委譲
  // 実際の強AI呼び出しは codex-do が行う
  const promptFile = path.join(REPO_ROOT, '.steering', `.improve-prompt-${Date.now()}.md`);
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  const codexDo = path.join(REPO_ROOT, 'tools/codex-do.mjs');
  const result = spawnSync(process.execPath, [
    codexDo, '--prompt-file', promptFile,
    '--cwd', REPO_ROOT,
    '--timeout', '300',
    '--origin', 'unattended',
    '--kind', 'investigate',
  ], { encoding: 'utf8', cwd: REPO_ROOT, timeout: 310000, windowsHide: true });

  // プロンプトファイルをクリーンアップ
  try { fs.unlinkSync(promptFile); } catch {}

  if (result.error) {
    console.error('強AI呼び出し失敗:', result.error.message);
    return null;
  }

  // 出力からJSONを抽出
  const output = result.stdout + result.stderr;
  const jsonMatch = output.match(/\{[\s\S]*"planId"[\s\S]*"tasks"[\s\S]*\}/);
  if (!jsonMatch) {
    console.error('強AIの応答からJSONを抽出できませんでした');
    console.error('出力:', output.slice(0, 1000));
    return null;
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.error('JSONパース失敗:', e.message);
    return null;
  }
}

function getDryRunPlan() {
  return {
    planId: `improve-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-dry`,
    target: { files: ['example.ts'], diffSummary: 'dry-run サンプル' },
    tasks: [
      {
        id: 'T1', title: 'サンプルタスク（dry-run）',
        file: 'example.ts', line: 42,
        description: 'これはdry-runのサンプルです',
        expectedChange: 'console.log → console.error',
        testRequired: false,
      },
    ],
    verification: ['dry-run: 検証なし'],
    cost: { estimatedTokens: 0, preferredLane: 'codex' },
  };
}

// ─── Phase 2: タスク実行 ───────────────────────────────

function executeTasks(plan, { lane = 'codex', cwd = REPO_ROOT, dryRun = false } = {}) {
  const results = [];
  for (const task of plan.tasks) {
    console.log(`\n--- タスク ${task.id}: ${task.title} ---`);

    if (dryRun) {
      console.log(`  [DRY RUN] スキップ: ${task.description}`);
      results.push({ ...task, status: 'skipped' });
      continue;
    }

    const taskPrompt = `ファイル ${task.file}（行 ${task.line}）に対して以下の修正を行ってください:

${task.description}

期待される変更: ${task.expectedChange}
${task.testRequired ? '\nテストも追加または更新してください。' : ''}

注意: このファイル以外は変更しないでください。`;

    const promptFile = path.join(cwd, '.steering', `.improve-task-${task.id}-${Date.now()}.md`);
    fs.mkdirSync(path.dirname(promptFile), { recursive: true });
    fs.writeFileSync(promptFile, taskPrompt, 'utf-8');

    const codexDo = path.join(REPO_ROOT, 'tools/codex-do.mjs');
    const start = Date.now();
    const result = spawnSync(process.execPath, [
      codexDo, '--prompt-file', promptFile,
      '--cwd', cwd,
      '--timeout', '300',
      '--origin', 'unattended',
      '--kind', 'implement',
    ], { encoding: 'utf8', cwd, timeout: 310000, windowsHide: true });

    try { fs.unlinkSync(promptFile); } catch {}

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const exitCode = result.status;

    // 終了コード75 = 保留（deferred）
    if (exitCode === 75) {
      console.log(`  ⏸ 保留（Codex上限）: ${elapsed}s`);
      results.push({ ...task, status: 'skipped' });
      continue;
    }

    if (exitCode !== 0) {
      console.log(`  ❌ 失敗 (exit ${exitCode}): ${elapsed}s`);
      results.push({ ...task, status: 'failed' });
    } else {
      console.log(`  ✅ 成功: ${elapsed}s`);
      results.push({ ...task, status: 'done' });
    }
  }
  return results;
}

// ─── Phase 3: 検証 ─────────────────────────────────────

function verifyPlan(plan, taskResults, { cwd = REPO_ROOT, dryRun = false } = {}) {
  console.log('\n=== Phase 3: 検証 ===');

  // タスク完了率
  const done = taskResults.filter(t => t.status === 'done').length;
  const total = taskResults.length;
  const completionRate = total > 0 ? (done / total * 100).toFixed(0) : 0;
  console.log(`タスク完了率: ${done}/${total} (${completionRate}%)`);

  // 検証項目チェック（dry-run時はスキップ）
  const verificationResults = [];
  if (!dryRun) {
    for (const v of plan.verification) {
      console.log(`  検証: ${v}`);
      // テスト実行
      if (v.toLowerCase().includes('テスト') || v.toLowerCase().includes('test')) {
        const testResult = spawnSync(process.execPath, ['--test', 'tools/*.test.mjs'], {
          encoding: 'utf8', cwd, timeout: 120000, windowsHide: true,
        });
        const passed = testResult.status === 0;
        verificationResults.push({ item: v, passed, detail: passed ? 'テスト通過' : `テスト失敗: ${testResult.stdout.slice(0, 200)}` });
        console.log(`    ${passed ? '✅' : '❌'} ${verificationResults[verificationResults.length - 1].detail}`);
      } else {
        verificationResults.push({ item: v, passed: null, detail: '自動検証未対応（目視確認推奨）' });
      }
    }
  }

  // 最終状態のdiff確認
  const finalDiff = getDiffStat(cwd);
  const diffChanged = finalDiff ? `残差分:\n${finalDiff}` : '全ての変更が適用されました';

  return {
    completionRate: parseInt(completionRate, 10),
    taskResults,
    verificationResults,
    finalDiff,
    summary: finalDiff ? `⚠ 未適用の差分があります` : `✅ 計画完了`,
  };
}

// ─── レポート出力 ──────────────────────────────────────

function printReport(plan, phase2Results, phase3Result, args) {
  console.log('\n═══════════════════════════════════════');
  console.log('  コード改善パイプライン レポート');
  console.log('═══════════════════════════════════════');
  console.log(`計画ID: ${plan.planId}`);
  console.log(`対象ファイル: ${plan.target.files.join(', ')}`);
  console.log(`要約: ${plan.target.diffSummary}`);
  console.log(`\nタスク一覧:`);
  for (const t of phase2Results) {
    const icon = t.status === 'done' ? '✅' : t.status === 'failed' ? '❌' : '⏸';
    console.log(`  ${icon} ${t.id}: ${t.title} (${t.file}:${t.line})`);
  }
  console.log(`\n検証結果:`);
  for (const v of phase3Result.verificationResults) {
    const icon = v.passed === true ? '✅' : v.passed === false ? '❌' : '❓';
    console.log(`  ${icon} ${v.item}: ${v.detail}`);
  }
  console.log(`\n完了率: ${phase3Result.completionRate}%`);
  console.log(phase3Result.summary);

  // レポートファイル保存
  const reportDir = path.join(args.cwd, '.steering');
  fs.mkdirSync(reportDir, { recursive: true });
  const reportFile = path.join(reportDir, `improve-report-${plan.planId}.json`);
  const report = { plan, results: phase2Results, verification: phase3Result, completedAt: new Date().toISOString() };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), 'utf-8');
  console.log(`\nレポート保存: ${reportFile}`);
}

// ─── メイン ────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);
  console.log('=== コード改善パイプライン ===');
  console.log(`モード: ${args.planOnly ? '計画のみ' : args.dryRun ? 'ドライラン' : 'フル'}`);
  console.log(`実装レーン: ${args.lane}`);
  console.log(`最大タスク数: ${args.maxTasks}`);

  // Phase 1: 強AIコード点検＋計画生成
  console.log('\n=== Phase 1: 強AIコード点検 ===');

  const diff = args.diff || getGitDiff(args.cwd, args.target);
  const diffStat = getDiffStat(args.cwd);

  console.log(`差分サイズ: ${diff.length} 文字`);
  console.log(diffStat || '(statなし)');

  const prompt = generateReviewPrompt(diff, diffStat, args.maxTasks);
  const plan = callStrongAi(prompt, { dryRun: args.dryRun });

  if (!plan) {
    console.error('計画生成に失敗しました');
    process.exit(1);
  }

  console.log(`\n計画生成完了: ${plan.planId}`);
  console.log(`  タスク数: ${plan.tasks.length}`);
  for (const t of plan.tasks) {
    console.log(`    ${t.id}: ${t.title} (${t.file}:${t.line})`);
  }

  // 計画を保存
  const planDir = path.join(args.cwd, '.steering');
  fs.mkdirSync(planDir, { recursive: true });
  const planFile = path.join(planDir, `improve-plan-${plan.planId}.json`);
  fs.writeFileSync(planFile, JSON.stringify(plan, null, 2), 'utf-8');
  console.log(`計画保存: ${planFile}`);

  if (args.planOnly || args.dryRun) {
    console.log('\n⏸ 計画のみモードのため停止します。');
    console.log(`実装を続けるには: node tools/code-improve-plan.mjs --verify-only ${planFile}`);
    process.exit(0);
  }

  // Phase 2: タスク実行
  console.log('\n=== Phase 2: 安AI実行 ===');
  const phase2Results = executeTasks(plan, { lane: args.lane, cwd: args.cwd, dryRun: args.dryRun });

  // Phase 3: 検証
  const phase3Result = verifyPlan(plan, phase2Results, { cwd: args.cwd, dryRun: args.dryRun });

  // レポート出力
  printReport(plan, phase2Results, phase3Result, args);

  // 終了コード
  const hasFailures = phase2Results.some(t => t.status === 'failed');
  process.exit(hasFailures ? 1 : 0);
}

// ─── エクスポート（テスト用） ──────────────────────────

export {
  parseArgs,
  getGitDiff,
  getDiffStat,
  generateReviewPrompt,
  getDryRunPlan,
  callStrongAi,
  executeTasks,
  verifyPlan,
  printReport,
  main,
};

// ─── エントリポイント ──────────────────────────────────

if (isEntry(import.meta.url)) main();
