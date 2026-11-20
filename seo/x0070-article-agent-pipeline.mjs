#!/usr/bin/env node
/**
 * X-0070 記事エージェントパイプライン
 *
 * 見本記事・役割定義・作業フローの3つを渡すだけで、
 * 記事制作の前後工程10ステップを一括自動化する。
 *
 * 使い方:
 *   node seo/x0070-article-agent-pipeline.mjs --sample ./sample.md
 *   node seo/x0070-article-agent-pipeline.mjs --sample ./sample.md --role ./role.json
 *   node seo/x0070-article-agent-pipeline.mjs --sample ./sample.md --workflow ./wf.json --llm gemini
 *   node seo/x0070-article-agent-pipeline.mjs --sample ./sample.md --dry-run
 *   node seo/x0070-article-agent-pipeline.mjs --sample ./sample.md --mock
 *   node seo/x0070-article-agent-pipeline.mjs --sample ./sample.md --resume needs-analysis
 *   node seo/x0070-article-agent-pipeline.mjs --help
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SEO_DIR = path.resolve(__dirname);
const DATA_DIR = path.resolve(SEO_DIR, 'data');
const DEFAULT_OUTPUT_BASE = path.resolve(SEO_DIR, '..', 'outputs', 'X-0070');

// ─── LLM呼び出し ───

function callGemini(prompt, stepId) {
  const geminiCli = path.resolve(SEO_DIR, '..', 'tools', 'gemini-cli.mjs');
  if (!fs.existsSync(geminiCli)) {
    throw new Error(`gemini-cli not found at ${geminiCli}。--llm に他のバックエンドを指定するか、gemini-cli.mjs を設置してください。`);
  }
  const result = execFileSync('node', [geminiCli, '--prompt', prompt], {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 120_000,
  });
  return result.trim();
}

function callClaude(prompt) {
  // claude-code の呼び出し - 高コストのため通常は使用しない
  throw new Error('Claude LLM backend はこのバージョンでは未対応です。--llm gemini を使用してください。');
}

function callLlm(prompt, backend, stepId) {
  const b = (backend || 'gemini').toLowerCase();
  switch (b) {
    case 'gemini': return callGemini(prompt, stepId);
    case 'claude': return callClaude(prompt);
    default: throw new Error(`未知のLLMバックエンド: ${backend}`);
  }
}

// ─── ファイル読み込み ───

function loadJson(absPath) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`ファイルが見つかりません: ${absPath}`);
  }
  return JSON.parse(fs.readFileSync(absPath, 'utf-8'));
}

function loadMarkdown(absPath) {
  if (!fs.existsSync(absPath)) {
    throw new Error(`ファイルが見つかりません: ${absPath}`);
  }
  return fs.readFileSync(absPath, 'utf-8');
}

function loadSampleArticle(samplePath) {
  if (!samplePath) throw new Error('--sample は必須です。');
  const ext = path.extname(samplePath).toLowerCase();
  if (ext === '.json') {
    return loadJson(samplePath);
  }
  const content = loadMarkdown(samplePath);
  const lines = content.split('\n');
  const titleLine = lines.find(l => l.startsWith('# ') || l.startsWith('title:'));
  const title = titleLine
    ? titleLine.replace(/^#\s*/, '').replace(/^title:\s*/, '').trim()
    : path.basename(samplePath, ext);
  return { title, content, path: samplePath };
}

// ─── モックデータ ───

function generateMockOutput(stepId, label) {
  const mocks = {
    'needs-analysis': {
      targetAudience: '中小企業のマーケティング担当者',
      searchIntent: '展示会ブース制作の費用対効果を知りたい',
      coverPoints: ['予算計画の立て方', 'デザインの選び方', '施工会社の選定基準'],
      differentiator: '実績ベースの具体的なアドバイス',
    },
    'headline-composition': {
      h1: '展示会ブース制作で失敗しないための完全ガイド',
      h2s: ['予算計画の立て方', 'デザイン決定のポイント', '施工会社の選び方'],
      h3s: [
        { h2: '予算計画の立て方', h3s: ['想定費用の内訳', '削れる費用・削れない費用'] },
      ],
    },
    'thumbnail-plan': [
      { concept: '成功と失敗の対比', palette: ['#1a365d', '#e2e8f0'], elements: '写真+グラフ' },
    ],
    'social-proof': {
      commonVoices: ['費用が読めない', 'どこに頼めばいいかわからない'],
      trends: ['リブース需要の増加', 'デザイン重視の傾向'],
    },
    'article-draft': '# 展示会ブース制作で失敗しないための完全ガイド\n\n## 予算計画の立て方\n\n（モック: 本文は省略されています）',
    'wordpress-format': '<h2>予算計画の立て方</h2>\n<p>（モック: WordPress HTML）</p>',
    'link-suggestions': [
      { anchorText: 'ブース制作サービス', url: '/service/booth-production', position: 'after-h2-1' },
    ],
    'meta-generation': {
      title: '展示会ブース制作完全ガイド',
      description: '予算計画から施工会社選定まで、失敗しない展示会ブース制作のポイントを解説',
      ogp: { 'og:title': '展示会ブース制作完全ガイド', 'og:type': 'article' },
      jsonLd: { '@context': 'https://schema.org', '@type': 'Article', headline: '展示会ブース制作完全ガイド' },
    },
    'quality-check': { passed: true, issues: [] },
  };
  return mocks[stepId] || { mock: true, stepId, label };
}

// ─── プロンプト構築 ───

function buildPrompt(template, context) {
  let result = template;
  for (const [key, value] of Object.entries(context)) {
    const placeholder = `{${key}}`;
    const strValue = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
    result = result.replaceAll(placeholder, strValue);
  }
  return result;
}

function prepareContext(sample, role, stepResults) {
  return {
    sample: sample.content,
    sampleTitle: sample.title,
    targetAudience: (role && role.targetAudience) || '一般',
    roleName: (role && role.name) || '記事執筆者',
    role: role ? JSON.stringify(role, null, 2) : 'デフォルト',
    internalPages: (role && role.internalPages)
      ? JSON.stringify(role.internalPages, null, 2)
      : '[]',
    ...stepResults,
    articleDraftExcerpt: stepResults['article-draft']
      ? stepResults['article-draft'].substring(0, 200)
      : '',
  };
}

// ─── ステップ実行 ───

function executeStep(step, context, backend, mockMode) {
  const { id, label, promptTemplate, llm, type } = step;
  const stepBackend = llm || backend;

  if (mockMode) {
    console.error(`  [MOCK] ${id}: ${label}`);
    return generateMockOutput(id, label);
  }

  if (type === 'collect') {
    // 収集系ステップ（口コミ等）- 将来的にWebFetchなどと統合
    console.error(`  [LLM:${stepBackend}] ${id}: ${label}`);
    const prompt = buildPrompt(promptTemplate, context);
    const raw = callLlm(prompt, stepBackend, id);
    return parseLlmOutput(raw, id);
  }

  console.error(`  [LLM:${stepBackend}] ${id}: ${label}`);
  const prompt = buildPrompt(promptTemplate, context);
  const raw = callLlm(prompt, stepBackend, id);
  return parseLlmOutput(raw, id);
}

function parseLlmOutput(raw, stepId) {
  // JSONを試しにパース
  const jsonMatch = raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      // JSONパース失敗 → 文字列として返す
    }
  }
  return raw;
}

// ─── 依存関係解決 ───

function resolveStepOrder(steps) {
  const ordered = [];
  const visited = new Set();

  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const step = steps.find(s => s.id === id);
    if (!step) throw new Error(`未定義のステップ: ${id}`);
    if (step.dependsOn) {
      for (const dep of step.dependsOn) {
        visit(dep);
      }
    }
    ordered.push(step);
  }

  for (const step of steps) {
    if (!visited.has(step.id)) {
      visit(step.id);
    }
  }
  return ordered;
}

// ─── 成果物出力 ───

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function writeOutput(dir, filename, data) {
  const filePath = path.join(dir, filename);
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  fs.writeFileSync(filePath, content, 'utf-8');
  return filePath;
}

function generatePipelineReport(sample, role, workflow, stepResults, outputDir, elapsedMs) {
  const lines = [];
  lines.push(`# X-0070 記事エージェントパイプライン 実行レポート`);
  lines.push(``);
  lines.push(`実行日時: ${new Date().toISOString()}`);
  lines.push(`所要時間: ${(elapsedMs / 1000).toFixed(1)}秒`);
  lines.push(`見本記事: ${sample.title} (${sample.path})`);
  lines.push(`役割定義: ${(role && role.name) || 'デフォルト'}`);
  lines.push(`ワークフロー: ${(workflow && workflow.name) || 'デフォルト10工程'}`);
  lines.push(``);
  lines.push(`## 実行ステップ一覧`);
  lines.push(``);
  lines.push(`| # | ステップ | 状態 | 成果物 |`);
  lines.push(`|---|----------|------|--------|`);

  const resolved = resolveStepOrder(workflow ? workflow.steps : []);
  resolved.forEach((step, i) => {
    const result = stepResults[step.id];
    const status = result ? '✅ 完了' : '⏭️ スキップ';
    const outputFile = step.output || '-';
    lines.push(`| ${i + 1} | ${step.label} | ${status} | ${outputFile} |`);
  });

  lines.push(``);
  lines.push(`## 出力ディレクトリ`);
  lines.push(``);
  lines.push(`\`${outputDir}\``);

  const hasIssues = stepResults['quality-check']
    && stepResults['quality-check'].issues
    && stepResults['quality-check'].issues.length > 0;

  if (hasIssues) {
    lines.push(``);
    lines.push(`## 品質チェック結果`);
    lines.push(``);
    for (const issue of stepResults['quality-check'].issues) {
      lines.push(`- [${issue.severity}] ${issue.location}: ${issue.description}`);
    }
  }
  return lines.join('\n');
}

// ─── メインパイプライン ───

async function main() {
  const args = parseArgs();
  if (args.help) {
    showHelp();
    return;
  }

  const startTime = Date.now();

  // 1. 入力を読み込む
  console.error('=== X-0070 記事エージェントパイプライン ===');
  console.error('');

  console.error('📄 見本記事を読み込み中...');
  const sample = loadSampleArticle(args.sample);
  console.error(`   → "${sample.title}" (${sample.content.length}文字)`);

  const rolePath = args.role || path.join(DATA_DIR, 'x0070-default-role.json');
  console.error(`👤 役割定義を読み込み中... (${rolePath})`);
  const role = loadJson(rolePath);

  const workflowPath = args.workflow || path.join(DATA_DIR, 'x0070-default-workflow.json');
  console.error(`⚙️  ワークフローを読み込み中... (${workflowPath})`);
  const workflow = loadJson(workflowPath);

  // 2. 実行順序を決定
  const steps = workflow.steps;
  const resolved = resolveStepOrder(steps);

  // レジューム位置を確認
  let resumeFrom = args.resume;
  if (resumeFrom) {
    const resumeIndex = resolved.findIndex(s => s.id === resumeFrom);
    if (resumeIndex === -1) {
      console.error(`⚠️  レジューム位置 "${resumeFrom}" が見つかりません。先頭から実行します。`);
      resumeFrom = null;
    }
  }

  // 3. 出力ディレクトリ
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
  const outputDir = args.output || path.join(DEFAULT_OUTPUT_BASE, timestamp);
  ensureDir(outputDir);
  console.error(`📁 出力先: ${outputDir}`);

  // 4. context準備
  const context = prepareContext(sample, role, {});

  // 5. 各ステップを実行（dry-run/mock対応）
  const stepResults = {};
  let started = !resumeFrom;
  const backend = args.llm || 'gemini';
  const mockMode = !!args.mock;
  const dryRun = !!args.dryRun;

  console.error('');
  console.error(`🔧 実行設定: backend=${backend} mock=${mockMode} dry-run=${dryRun} resume=${resumeFrom || 'なし'}`);
  console.error('');

  for (const step of resolved) {
    if (!started) {
      if (step.id === resumeFrom) started = true;
      else {
        console.error(`  ⏭️  ${step.id}: ${step.label} (レジューム前のためスキップ)`);
        continue;
      }
    }

    const { id, output } = step;

    if (dryRun) {
      console.error(`  📋 [DRY-RUN] ${id}: ${step.label} → ${output || '(なし)'}`);
      // dry-runではテンプレートファイルを作成
      if (output) {
        const templatePath = path.join(outputDir, output + '.template');
        fs.writeFileSync(templatePath, step.promptTemplate || '', 'utf-8');
        console.error(`     → テンプレート: ${templatePath}`);
      }
      continue;
    }

    try {
      const result = executeStep(step, { ...context, ...stepResults }, backend, mockMode);
      stepResults[id] = result;

      // 各ステップの結果を個別に保存
      if (output) {
        const savedPath = writeOutput(outputDir, output, result);
        console.error(`  ✅ ${id}: ${output} (${savedPath})`);
      } else {
        console.error(`  ✅ ${id}: 完了 (出力なし)`);
      }

      // contextを更新（次のステップで使えるように）
      context[id] = result;
    } catch (err) {
      console.error(`  ❌ ${id}: エラー - ${err.message}`);
      if (args.verbose) {
        console.error(err.stack);
      }
      // エラーでも後続ステップは続行（出力なしとして扱う）
      stepResults[id] = { error: err.message };
      context[id] = '';
    }
  }

  // 6. レポート生成
  console.error('');
  console.error('📊 レポート生成中...');
  const report = generatePipelineReport(sample, role, workflow, stepResults, outputDir, Date.now() - startTime);
  writeOutput(outputDir, 'pipeline-report.md', report);
  console.error(`   → ${path.join(outputDir, 'pipeline-report.md')}`);

  // 7. サマリ
  const totalSteps = resolved.length;
  const completedSteps = Object.keys(stepResults).length;
  console.error('');
  console.error('=== 実行完了 ===');
  console.error(`   完了: ${completedSteps}/${totalSteps} ステップ`);
  console.error(`   出力: ${outputDir}`);

  // データファイルの準備（内部リンク用）
  if (role && role.internalPages && !args.dryRun) {
    writeOutput(outputDir, 'internal-pages-reference.json', role.internalPages);
  }

  // JSONのみモード
  if (args.jsonOnly) {
    process.stdout.write(JSON.stringify(stepResults, null, 2));
  } else {
    process.stdout.write(`✅ X-0070 パイプライン完了: ${outputDir}\n`);
  }
}

// ─── CLI引数解析 ───

function parseArgs() {
  const args = {};
  const raw = process.argv.slice(2);

  for (let i = 0; i < raw.length; i++) {
    switch (raw[i]) {
      case '--help':
      case '-h':
        args.help = true; break;
      case '--sample':
        args.sample = raw[++i]; break;
      case '--role':
        args.role = raw[++i]; break;
      case '--workflow':
        args.workflow = raw[++i]; break;
      case '--output':
        args.output = raw[++i]; break;
      case '--llm':
        args.llm = raw[++i]; break;
      case '--dry-run':
        args.dryRun = true; break;
      case '--mock':
        args.mock = true; break;
      case '--resume':
        args.resume = raw[++i]; break;
      case '--json-only':
        args.jsonOnly = true; break;
      case '--verbose':
        args.verbose = true; break;
      default:
        console.error(`⚠️  未知のオプション: ${raw[i]}`);
    }
  }
  return args;
}

function showHelp() {
  const help = `
X-0070 記事エージェントパイプライン

見本記事・役割定義・作業フローの3つを渡すだけで、
記事制作の前後工程10ステップを一括自動化します。

使い方:
  node seo/x0070-article-agent-pipeline.mjs --sample <path> [options]

必須:
  --sample <path>   見本記事ファイル（Markdown/HTML/JSON）

オプション:
  --role <path>     役割定義JSON（省略時: data/x0070-default-role.json）
  --workflow <path> 作業フローJSON（省略時: data/x0070-default-workflow.json）
  --output <dir>    出力ディレクトリ（省略時: outputs/X-0070/<日時>/）
  --llm gemini      LLMバックエンド（default: gemini, 現在はgeminiのみ）
  --dry-run         テンプレートのみ出力（LLM呼び出しなし）
  --mock            モックデータで実行（LLM呼び出しなし）
  --resume <step>   指定ステップから再開
  --json-only       結果をJSONでstdoutに出力
  --verbose         詳細ログ

ステップ一覧（デフォルトワークフロー）:
   1. needs-analysis       ニーズ分析・ターゲット特定
   2. headline-composition 見出し構成（SEO最適化）
   3. thumbnail-plan       サムネイル・画像案
   4. social-proof         口コミ・ソーシャルプルーフ収集
   5. article-draft        記事本文執筆
   6. wordpress-format     WordPress整形
   7. link-settings        リンク設定
   8. meta-generation      メタ情報・構造化データ
   9. quality-check        品質チェック

出力ファイル（outputs/X-0070/<日時>/）:
   needs-analysis.json
   headlines.json
   thumbnail-plan.json
   social-proof.json
   article-draft.md
   wordpress-body.html
   link-suggestions.json
   meta.json
   quality-report.json
   internal-pages-reference.json
   pipeline-report.md

使用例:
  node seo/x0070-article-agent-pipeline.mjs --sample ./sample.md
  node seo/x0070-article-agent-pipeline.mjs --sample ./sample.md --mock
  node seo/x0070-article-agent-pipeline.mjs --sample ./sample.md --dry-run
  node seo/x0070-article-agent-pipeline.mjs --sample ./sample.md --resume article-draft
  node seo/x0070-article-agent-pipeline.mjs --sample ./sample.md --json-only --mock
`;
  process.stdout.write(help);
}

// ─── エントリーポイント ───

const isEntry = process.argv[1] && (
  path.resolve(process.argv[1]) === __filename
);

if (isEntry) {
  main().catch(err => {
    console.error('❌ パイプラインエラー:', err.message);
    if (process.argv.includes('--verbose')) {
      console.error(err.stack);
    }
    process.exit(1);
  });
}

export { resolveStepOrder, prepareContext, buildPrompt, parseLlmOutput, generateMockOutput };