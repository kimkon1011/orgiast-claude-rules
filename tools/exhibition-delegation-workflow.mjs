#!/usr/bin/env node
/**
 * Exhibition Planning Delegation Workflow
 *
 * 展示会企画の計画→ブースデザイン実装→レビューを
 * 3体のサブエージェントに委譲するワークフロー自動化スクリプト。
 *
 * Usage:
 *   node tools/exhibition-delegation-workflow.mjs [--review] [--plan-only] [--skip-plan]
 *
 * オプション:
 *   --review      レビューエージェントも実行する
 *   --plan-only   計画エージェントのみ実行
 *   --skip-plan   計画をスキップ（既存の計画を使って実装から開始）
 *   --output-dir <path>  出力先ディレクトリ（デフォルト: apps/expo-apply/projects/<client>/）
 *   --client <name>      クライアント名（デフォルト: C0056-2027-kansai-monodzukuri）
 *
 * 環境変数:
 *   REPO_DIR      リポジトリルート（デフォルト: スクリプト位置から自動検出）
 *
 * 依存: tools/codex-do.mjs, tools/llm-ask.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO_DIR || path.resolve(__dirname, '..');
const TOOLS = path.join(REPO, 'tools');

// ---- CLI args ----
const args = process.argv.slice(2);
const FLAGS = {
  review: args.includes('--review'),
  planOnly: args.includes('--plan-only'),
  skipPlan: args.includes('--skip-plan'),
  outputDir: null,
  client: 'C0056-2027-kansai-monodzukuri',
};
const optIdx = args.indexOf('--output-dir');
if (optIdx !== -1 && args[optIdx + 1]) FLAGS.outputDir = args[optIdx + 1];
const cliIdx = args.indexOf('--client');
if (cliIdx !== -1 && args[cliIdx + 1]) FLAGS.client = args[cliIdx + 1];

// ---- Helpers ----
function log(label, msg) {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [${label}] ${msg}`);
}

function runTool(script, ...toolArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [script, ...toolArgs], {
      cwd: REPO,
      stdio: ['inherit', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('close', code => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`Exit ${code}: ${stderr.slice(0, 500)}`));
    });
    child.on('error', reject);
  });
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function writeFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf-8');
  log('FILE', `Wrote ${path.relative(REPO, filePath)} (${content.length} bytes)`);
}

// ---- Phase 1: Plan ----
async function phasePlan(client) {
  log('PLAN', '=== Phase 1: Planning ===');

  const planPrompt = `あなたは展示会企画の計画エージェントです。
株式会社オージャスト（https://orgiast.jp）の展示会ブース制作プロジェクトにおいて、
新しいクライアント向けの展示会企画を立案してください。

## クライアント想定
- クライアントID: ${client}
- 業種: 精密機械部品製造
- 出展する展示会: 「2027 関西ものづくりワールド」（インテックス大阪）
- ブースサイズ: 6m × 3m（18m²）
- 予算: 150万円〜200万円
- 目的: 新規リード獲得（目標50件）とブランド認知向上
- ターゲット: 製造業の設備投資担当者・製造部長

## 既存リソース
1. apps/expo-apply/freebies/exhibition-planning-template.md — 展示会出展計画テンプレート
2. apps/expo-apply/freebies/booth-readiness-diagnostic.md — ブース準備度診断
3. apps/expo-apply/freebies/booth-preparation-checklist.md — 準備チェックリスト
4. docs/ai-news-x0009-sme-exhibition-strategy-shift.md — 展示会戦略ナレッジ
5. data/booth-projects.json — 過去プロジェクトデータ

## 依頼
このタスクで「変えるべきファイル」を変更順に一覧で出してください。
1. どの既存ファイルを修正するか
2. どの新しいファイルを作成するか
3. それぞれの変更内容の概要と優先順位`;

  // Try using codex-do with investigate mode
  try {
    const result = await runTool(
      path.join(TOOLS, 'codex-do.mjs'),
      planPrompt,
      '--kind', 'investigate',
      '--cwd', REPO,
      '--origin', 'workflow',
    );
    log('PLAN', `Plan result (${result.length} chars)`);
    return result;
  } catch (err) {
    log('PLAN', `Plan agent failed: ${err.message}. Using fallback template.`);
    return getDefaultPlan(client);
  }
}

function getDefaultPlan(client) {
  return `## 計画: ${client}

### 作成すべきファイル（優先順位順）
1. **01_企画概要.md** — 企業概要、出展目的、ターゲット定義、KPI
2. **02_ブース設計企画書.md** — 6m×3mレイアウト、導線設計、展示方法
3. **03_スケジュール.md** — 逆算マイルストーン
4. **04_予算計画.md** — 150-200万円の予算配分
5. **05_リード獲得戦略.md** — 目標50件の施策`;
}

// ---- Phase 2: Design Implementation ----
async function phaseDesign(client, plan) {
  log('DESIGN', '=== Phase 2: Design Implementation ===');

  const outputBase = FLAGS.outputDir || path.join(REPO, 'apps', 'expo-apply', 'projects', client);
  ensureDir(outputBase);

  // Read existing templates and resources
  const templatePath = path.join(REPO, 'apps', 'expo-apply', 'freebies', 'exhibition-planning-template.md');
  const knowledgePath = path.join(REPO, 'docs', 'ai-news-x0009-sme-exhibition-strategy-shift.md');
  const projectsPath = path.join(REPO, 'data', 'booth-projects.json');

  const template = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, 'utf-8') : '';
  const knowledge = fs.existsSync(knowledgePath) ? fs.readFileSync(knowledgePath, 'utf-8') : '';
  const projects = fs.existsSync(projectsPath) ? fs.readFileSync(projectsPath, 'utf-8') : '';

  const designPrompt = `あなたは展示会ブースデザインの実装エージェントです。

クライアント「${client}」（精密機械部品製造）の
「2027 関西ものづくりワールド」（インテックス大阪）向けに、
6m×3m（18m²）のブースを企画・設計します。

予算: 150万円〜200万円
目的: 新規リード獲得（目標50件）とブランド認知向上
ターゲット: 製造業の設備投資担当者・製造部長

出力先ディレクトリ: ${outputBase}

以下の5つの文書をマークダウン形式・日本語で作成してください。

### 1. 01_企画概要.md
- 企業概要、出展目的、ターゲット定義、KPI（リード50件、商談20件、成約3件）
- ブース基本スペック（6m×3m、18m²）
- 成功条件と測定方法

### 2. 02_ブース設計企画書.md
- 6m×3mのレイアウト案（壁面構成、商談スペース4席、展示什器）
- 導線設計（来場者が自然に製品エリア→商談エリアへ流れる）
- 視認性確保策（高所サイン、通路からの視認性）
- 精密機械部品の展示方法（実機展示＋パネル展示のハイブリッド提案）

### 3. 03_スケジュール.md
- 2027年開催に向けた逆算スケジュール
- マイルストーン（出展申込→デザイン確定→施工発注→設営→本番→撤収）

### 4. 04_予算計画.md
- 150万〜200万円の予算配分
- 内訳（ブース構築費/輸送費/設営撤去費/ノベルティ/人件費/予備費）

### 5. 05_リード獲得戦略.md
- 目標50件のリード獲得施策
- ブース接客フロー、見込み客属性別アプローチ
- 名刺交換→フォローアップまでの導線
- 展示会後のナーチャリング計画

既存テンプレート（以下参照）の項目を全てカバーしつつ、
ナレッジ記事の知見（投資思考・フォローアップ設計・継続改善）を反映してください。

=== テンプレート ===
${template.slice(0, 2000)}

=== ナレッジ ===
${knowledge.slice(0, 1500)}

=== 既存プロジェクト ===
${projects.slice(0, 1500)}`;

  try {
    await runTool(
      path.join(TOOLS, 'codex-do.mjs'),
      designPrompt,
      '--kind', 'implement',
      '--cwd', REPO,
      '--origin', 'workflow',
      '--timeout', '300',
    );
    log('DESIGN', 'Design implementation completed');
  } catch (err) {
    log('DESIGN', `Design agent failed: ${err.message}. Files may be incomplete.`);
  }

  // Verify created files
  const files = ['01_企画概要.md', '02_ブース設計企画書.md', '03_スケジュール.md', '04_予算計画.md', '05_リード獲得戦略.md'];
  const results = [];
  for (const f of files) {
    const fp = path.join(outputBase, f);
    if (fs.existsSync(fp)) {
      const size = fs.statSync(fp).size;
      results.push(`  ✅ ${f} (${size} bytes)`);
    } else {
      results.push(`  ❌ ${f} — NOT FOUND`);
    }
  }
  log('DESIGN', `Results:\n${results.join('\n')}`);
  return results;
}

// ---- Phase 3: Review ----
async function phaseReview(client) {
  log('REVIEW', '=== Phase 3: Review ===');

  const projectDir = FLAGS.outputDir || path.join(REPO, 'apps', 'expo-apply', 'projects', client);

  // Read all created files
  const fileNames = ['01_企画概要.md', '02_ブース設計企画書.md', '03_スケジュール.md', '04_予算計画.md', '05_リード獲得戦略.md'];
  const fileContents = {};
  for (const f of fileNames) {
    const fp = path.join(projectDir, f);
    if (fs.existsSync(fp)) {
      fileContents[f] = fs.readFileSync(fp, 'utf-8');
    }
  }

  const reviewPrompt = `あなたは展示会企画のレビューエージェントです。
以下の5つの企画文書をレビューしてください。

## レビュー観点
1. **一貫性**: 5ファイル間で数値（予算・KPI・日程）に矛盾はないか
2. **テンプレート充足度**: exhibition-planning-template.mdの全項目をカバーしているか
3. **実現可能性**: 予算150-200万円で6m×3mブースは実現可能か、KPI50件リードは現実的か
4. **具体性**: レイアウト・導線・展示方法は具体的に記述されているか
5. **ナレッジ反映**: 投資思考・フォローアップ設計・継続改善サイクルが反映されているか
6. **改善提案**: 不足している点、追加すべき項目

## 出力形式
- 各ファイルの評価（良かった点・問題点）
- 優先順位付きの改善提案リスト
- 総合評価（5段階）

=== 01_企画概要.md ===
${(fileContents['01_企画概要.md'] || 'NOT FOUND').slice(0, 2000)}

=== 02_ブース設計企画書.md ===
${(fileContents['02_ブース設計企画書.md'] || 'NOT FOUND').slice(0, 2000)}

=== 03_スケジュール.md ===
${(fileContents['03_スケジュール.md'] || 'NOT FOUND').slice(0, 2000)}

=== 04_予算計画.md ===
${(fileContents['04_予算計画.md'] || 'NOT FOUND').slice(0, 2000)}

=== 05_リード獲得戦略.md ===
${(fileContents['05_リード獲得戦略.md'] || 'NOT FOUND').slice(0, 2000)}`;

  try {
    const result = await runTool(
      path.join(TOOLS, 'codex-do.mjs'),
      reviewPrompt,
      '--kind', 'investigate',
      '--cwd', REPO,
      '--origin', 'workflow',
    );
    log('REVIEW', `Review completed (${result.length} chars)`);
    return result;
  } catch (err) {
    log('REVIEW', `Review agent failed: ${err.message}`);
    return 'Review failed to complete.';
  }
}

// ---- Main ----
async function main() {
  const startTime = Date.now();
  const client = FLAGS.client;

  log('MAIN', `Starting delegation workflow for client: ${client}`);
  log('MAIN', `Flags: review=${FLAGS.review}, planOnly=${FLAGS.planOnly}, skipPlan=${FLAGS.skipPlan}`);

  // Phase 1: Plan
  let plan = '';
  if (!FLAGS.skipPlan) {
    plan = await phasePlan(client);
    const planFile = path.join(REPO, 'apps', 'expo-apply', 'projects', client, '_plan.md');
    writeFile(planFile, plan);
  } else {
    plan = getDefaultPlan(client);
    log('MAIN', 'Skipped planning phase, using default plan');
  }

  if (FLAGS.planOnly) {
    log('MAIN', 'Plan-only mode. Exiting.');
    printSummary(startTime, client, { plan });
    return;
  }

  // Phase 2: Design
  const designResults = await phaseDesign(client, plan);

  // Phase 3: Review (optional)
  let reviewResult = '';
  if (FLAGS.review) {
    reviewResult = await phaseReview(client);
    const reviewFile = path.join(REPO, 'apps', 'expo-apply', 'projects', client, '_review.md');
    writeFile(reviewFile, reviewResult);
  }

  printSummary(startTime, client, { plan, designResults, reviewResult });
}

function printSummary(startTime, client, { plan, designResults, reviewResult }) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log('\n' + '='.repeat(60));
  console.log('  DELEGATION WORKFLOW COMPLETE');
  console.log('='.repeat(60));
  console.log(`  Client:     ${client}`);
  console.log(`  Elapsed:    ${elapsed}s`);
  console.log(`  Plan:       ${plan ? `${plan.length} chars` : 'skipped'}`);
  console.log(`  Design:     ${designResults ? designResults.filter(r => r.includes('✅')).length + '/5 files' : 'N/A'}`);
  console.log(`  Review:     ${reviewResult ? `${reviewResult.length} chars` : 'skipped'}`);
  console.log('='.repeat(60));
  console.log('\n  Usage:');
  console.log(`    node tools/exhibition-delegation-workflow.mjs --review`);
  console.log(`    node tools/exhibition-delegation-workflow.mjs --plan-only`);
  console.log(`    node tools/exhibition-delegation-workflow.mjs --client "custom-client"`);
  console.log('='.repeat(60));
}

main().catch(err => {
  console.error('Workflow failed:', err);
  process.exit(1);
});
