#!/usr/bin/env node
// Booth design benchmark — quality/cost simulation across 3 models using specification fixtures.
// No API calls; all prices, latency, and quality scores are specification fixtures.
import fs from 'node:fs';
import { classifyTask, estimateCost, ROUTING_TABLE } from './model-router.mjs';
import { isEntry } from './is-entry.mjs';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Output token estimates per task category. */
const OUTPUT_TOKENS_BY_CATEGORY = Object.freeze({
  planning: 1500,
  design: 2000,
  copy: 500,
  listing: 1500,
  layout: 2000,
  construction: 2000,
  research: 1500,
  budget: 1500,
  operation: 1500,
  technology: 1500,
  evaluation: 1000,
  signage: 1500,
});

/** Map model ID to ROUTING_TABLE route key for pricing. */
const MODEL_ROUTE_MAP = Object.freeze({
  'deepseek/deepseek-v4-flash': 'simple',
  'moonshotai/kimi-k3': 'medium',
  'openai/gpt-4o': 'complex',
});

/** Booth design task definitions (specification fixtures). */
export const BOOTH_DESIGN_TASKS = Object.freeze([
  { id: 'bd-01', title: 'ブース基本企画案', category: 'planning', text: '展示会ブースの基本企画案を作成してください。ターゲット来場者、伝えたいメッセージ、ブースの性格（プレゼン型/体験型/商談型）を含めて、A4 1枚程度にまとめてください。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-02', title: 'デザインコンセプト作成', category: 'design', text: 'モダンで開放的、かつ来場者が自然と立ち寄りたくなるブースデザインのコンセプトを提案してください。使用する色彩（2〜3色）、素材感、照明計画を含めて記述してください。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-03', title: 'レイアウト図作成指示', category: 'layout', text: '3m×3mの小間ブースのレイアウトを設計してください。カウンター、パネル、展示什器、来場者動線を考慮し、東西からの見え方も考慮してください。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-04', title: 'キャッチコピー生成', category: 'copy', text: '展示会ブース「環境ソリューションEXPO」向けのキャッチコピーを5案作成してください。サブコピーも各1行添えてください。ターゲットは製造業の環境担当者です。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-05', title: '展示品リスト作成', category: 'listing', text: '半導体製造装置展示ブースに適した展示品リストを10項目作成してください。各項目に展示の目的と想定される来場者メリットを1行ずつ付けてください。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-06', title: '配色提案', category: 'design', text: 'IT企業向け展示ブースの配色を3案提案してください。企業イメージ（青系・テクノロジー）を維持しつつ、展示会場内で目立つ組み合わせを選んでください。各案に使用割合（%）を付けてください。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-07', title: '施工指示書作成', category: 'construction', text: '3間×3間の島ブースの施工指示書を作成してください。壁面パネル、床材、照明、電気配線の仕様を箇条書きで列挙し、施工順序も記載してください。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-08', title: '来場者ターゲット分析', category: 'research', text: '環境展示会に来場する想定来場者層を分析し、3つのペルソナを作成してください。各ペルソナに役職、関心事項、ブースで見たい情報、行動パターンを含めてください。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-09', title: '予算案作成', category: 'budget', text: '3日間の展示会ブース（施工・運営・撤去込み）の予算案を項目別に作成してください。想定規模は小間9小間、予算上限300万円です。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-10', title: 'タイムライン作成', category: 'planning', text: '展示会出展決定から本番までのタイムラインを週単位で作成してください。標準スケジュールは出展決定から3ヶ月前とし、各工程のリードタイムと担当者を明示してください。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-11', title: '競合ブース調査分析', category: 'research', text: '同日程で開催される競合展示会の出展企業リストを分析し、当社ブースの差別化ポイントを3つ提案してください。各差別化ポイントに実装方法を併記してください。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-12', title: 'スタッフ接遇マニュアル作成', category: 'operation', text: '展示会ブースのスタッフ向け接遇マニュアルを作成してください。来場者への声かけ方法、商談の進め方、名刺交換の注意点、1日のタイムスケジュールを含めてください。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-13', title: 'デジタル活用施策', category: 'technology', text: 'ブースでのデジタル技術活用施策を5案提案してください。タブレット/サイネージ/AR/VR/QRコードの中から選択し、各施策の導入コスト（概算）と期待効果を記載してください。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-14', title: 'ブース評価基準作成', category: 'evaluation', text: '展示会終了後のブース成果を評価するためのKPIと評価基準を作成してください。定量指標（リード獲得数等）と定性指標（ブランド認知等）の両方を含めてください。', minTokens: 50, maxTokens: 150 },
  { id: 'bd-15', title: '誘導サイン計画', category: 'signage', text: '展示会場内で自社ブースへ来場者を誘導するサイン計画を作成してください。入口からの導線、主要交差点でのサイン、ブース前面での訴求ポイントを含めてください。', minTokens: 50, maxTokens: 150 },
]);

/** Quality criteria template (shared across all booth tasks). */
export const BOOTH_QUALITY_CRITERIA = Object.freeze({
  criteria: ['網羅性（必須要素の過不足）', '具体性（数値・固有名詞の有無）', '実用性（そのまま実務に使えるか）', '独自性（テンプレート回答との差）'],
  maxScore: 10,
  scoringGuide: Object.freeze({
    coverage: '必須要素が全て含まれていれば高い。不足1要素につき-2点。',
    specificity: '数値・固有名詞・具体的な事例があるほど高い。抽象的な記述のみで-3点。',
    practicality: 'そのまま顧客に提示できる完成度。ポンチ絵レベルで-3点。',
    originality: '汎用テンプレートでない独自の視点や提案があるか。テンプレート感が強いと-3点。',
  }),
});

/** Quality score fixtures (specification values, not measured). */
export const BOOTH_QUALITY_FIXTURES = Object.freeze({
  'deepseek/deepseek-v4-flash': Object.freeze({
    'bd-01': 6.5, 'bd-02': 5.5, 'bd-03': 5.0, 'bd-04': 7.5, 'bd-05': 8.0,
    'bd-06': 6.0, 'bd-07': 4.5, 'bd-08': 7.0, 'bd-09': 6.5, 'bd-10': 7.5,
    'bd-11': 6.0, 'bd-12': 7.5, 'bd-13': 5.5, 'bd-14': 7.0, 'bd-15': 5.5,
  }),
  'moonshotai/kimi-k3': Object.freeze({
    'bd-01': 7.5, 'bd-02': 7.0, 'bd-03': 6.5, 'bd-04': 8.0, 'bd-05': 8.5,
    'bd-06': 7.0, 'bd-07': 6.0, 'bd-08': 8.0, 'bd-09': 7.5, 'bd-10': 8.0,
    'bd-11': 7.0, 'bd-12': 8.0, 'bd-13': 7.0, 'bd-14': 7.5, 'bd-15': 6.5,
  }),
  'openai/gpt-4o': Object.freeze({
    'bd-01': 8.5, 'bd-02': 8.5, 'bd-03': 8.0, 'bd-04': 9.0, 'bd-05': 9.0,
    'bd-06': 8.5, 'bd-07': 8.0, 'bd-08': 9.0, 'bd-09': 8.5, 'bd-10': 8.5,
    'bd-11': 8.5, 'bd-12': 8.5, 'bd-13': 8.0, 'bd-14': 8.5, 'bd-15': 8.0,
  }),
});

// ---------------------------------------------------------------------------
// Core functions
// ---------------------------------------------------------------------------

/**
 * Estimate cost for a booth task on a given route.
 * Input tokens = task.maxTokens (safe side), output = category-specific estimate.
 */
export function estimateBoothCost(taskId, route) {
  const task = BOOTH_DESIGN_TASKS.find(t => t.id === taskId);
  if (!task) throw new Error(`Unknown booth task: ${taskId}`);
  const outputTokens = OUTPUT_TOKENS_BY_CATEGORY[task.category];
  if (outputTokens === undefined) throw new Error(`Unknown category: ${task.category}`);
  return estimateCost(route, { input: task.maxTokens, output: outputTokens });
}

/**
 * Classify a text, then bump booth-related tasks to at least medium.
 */
export function classifyBoothTask(text) {
  const base = classifyTask(text);
  const boothKeywords = /企画|レイアウト|デザイン|予算|コピー|施工|ブース|展示|来場者|小間/i;
  if (boothKeywords.test(text)) {
    if (base === 'simple' || base === 'unknown') return 'medium';
    return base; // Already medium or complex
  }
  return base;
}

/**
 * Run the full booth benchmark: compute quality, cost, and cost-per-quality
 * for every task × model combination using specification fixtures.
 */
export function boothBenchmark(options = {}) {
  const models = options.models ?? Object.keys(BOOTH_QUALITY_FIXTURES);
  const tasks = options.tasks ?? BOOTH_DESIGN_TASKS;
  const qualityData = options.qualityData ?? BOOTH_QUALITY_FIXTURES;

  const results = [];
  for (const task of tasks) {
    for (const model of models) {
      const qualityScore = qualityData[model]?.[task.id];
      if (qualityScore === undefined) continue;
      const route = MODEL_ROUTE_MAP[model];
      if (!route) continue;
      const costUsd = estimateBoothCost(task.id, route);
      const costPerQuality = costUsd / qualityScore;
      results.push({
        taskId: task.id,
        title: task.title,
        category: task.category,
        model,
        qualityScore,
        costUsd,
        costPerQuality,
        inputTokens: task.maxTokens,
        outputTokens: OUTPUT_TOKENS_BY_CATEGORY[task.category],
      });
    }
  }

  // Per-model summary
  const modelsSummary = {};
  for (const model of models) {
    const mResults = results.filter(r => r.model === model);
    if (!mResults.length) continue;
    const totalQuality = mResults.reduce((s, r) => s + r.qualityScore, 0);
    const avgQuality = totalQuality / mResults.length;
    const totalCost = mResults.reduce((s, r) => s + r.costUsd, 0);
    const avgCostPerQuality = totalCost / totalQuality;
    modelsSummary[model] = { avgQuality, totalCost, avgCostPerQuality };
  }

  // Best per task (highest quality)
  const bestPerTask = {};
  for (const task of tasks) {
    const tResults = results.filter(r => r.taskId === task.id);
    if (!tResults.length) continue;
    const best = tResults.reduce((a, b) => a.qualityScore > b.qualityScore ? a : b);
    bestPerTask[task.id] = { model: best.model, qualityScore: best.qualityScore };
  }

  return { results, summary: { models: modelsSummary, bestPerTask } };
}

/**
 * Recommend routing based on quality-cost tradeoffs.
 * If gpt-4o's quality advantage over a cheaper model is ≤ 0.5, recommend the cheaper model.
 */
export function recommendedRouting(results) {
  const taskIds = [...new Set(results.map(r => r.taskId))];
  const routing = {};

  for (const taskId of taskIds) {
    const taskResults = results.filter(r => r.taskId === taskId);
    const gpt4o = taskResults.find(r => r.model === 'openai/gpt-4o');
    const deepseek = taskResults.find(r => r.model === 'deepseek/deepseek-v4-flash');
    const kimi = taskResults.find(r => r.model === 'moonshotai/kimi-k3');
    if (!gpt4o || !deepseek || !kimi) continue;

    // Cheaper models sorted by cost ascending
    const cheaper = [deepseek, kimi].sort((a, b) => a.costUsd - b.costUsd);

    let recommendation = null;
    for (const alt of cheaper) {
      const diff = gpt4o.qualityScore - alt.qualityScore;
      if (diff <= 0.5) {
        recommendation = {
          taskId,
          recommendedModel: alt.model,
          originalModel: 'openai/gpt-4o',
          qualityDiff: Math.abs(diff),
          costSaving: +(gpt4o.costUsd - alt.costUsd).toFixed(8),
          routingDecision: 'same_quality_cheaper',
        };
        break;
      }
    }

    if (!recommendation) {
      // No cheap model close enough; keep gpt-4o
      recommendation = {
        taskId,
        recommendedModel: 'openai/gpt-4o',
        originalModel: 'openai/gpt-4o',
        qualityDiff: 0,
        costSaving: 0,
        routingDecision: 'quality_premium',
      };
    }

    routing[taskId] = recommendation;
  }

  return routing;
}

// ---------------------------------------------------------------------------
// Markdown report generation
// ---------------------------------------------------------------------------

/**
 * Run the benchmark and render a full Markdown report.
 */
export function boothBenchmarkMarkdown() {
  const { results, summary } = boothBenchmark();
  const routing = recommendedRouting(results);

  const models = Object.keys(summary.models);
  const modelLabels = models.map(m => m.split('/')[1] || m);

  let md = '# Booth Design Benchmark Report\n\n';
  md += 'Specification fixture prices and quality scores; no API calls or billed cost.\n\n';

  // ── Quality Scores ──
  md += '## Quality Scores\n\n';
  md += '| Task | Category';
  for (const label of modelLabels) md += ` | ${label}`;
  md += ' | Best |\n|' + '---|'.repeat(3 + models.length) + '\n';

  for (const task of BOOTH_DESIGN_TASKS) {
    const tResults = results.filter(r => r.taskId === task.id);
    const best = tResults.length ? tResults.reduce((a, b) => a.qualityScore > b.qualityScore ? a : b) : null;
    md += `| ${task.title} | ${task.category}`;
    for (const model of models) {
      const r = tResults.find(x => x.model === model);
      md += ` | ${r ? r.qualityScore.toFixed(1) : '-'}`;
    }
    md += ` | ${best ? (best.model.split('/')[1] || best.model) : '-'} |\n`;
  }

  // ── Cost per Task ──
  md += '\n## Cost per Task (USD)\n\n';
  md += '| Task | Category';
  for (const label of modelLabels) md += ` | ${label}`;
  md += ' |\n|' + '---|'.repeat(2 + models.length) + '\n';

  for (const task of BOOTH_DESIGN_TASKS) {
    const tResults = results.filter(r => r.taskId === task.id);
    md += `| ${task.title} | ${task.category}`;
    for (const model of models) {
      const r = tResults.find(x => x.model === model);
      md += ` | ${r ? `$${r.costUsd.toFixed(6)}` : '-'}`;
    }
    md += ' |\n';
  }

  // ── Cost per Quality Point ──
  md += '\n## Cost per Quality Point (USD)\n\n';
  md += '| Task | Category';
  for (const label of modelLabels) md += ` | ${label}`;
  md += ' |\n|' + '---|'.repeat(2 + models.length) + '\n';

  for (const task of BOOTH_DESIGN_TASKS) {
    const tResults = results.filter(r => r.taskId === task.id);
    md += `| ${task.title} | ${task.category}`;
    for (const model of models) {
      const r = tResults.find(x => x.model === model);
      md += ` | ${r ? `$${r.costPerQuality.toFixed(6)}` : '-'}`;
    }
    md += ' |\n';
  }

  // ── Recommended Routing ──
  md += '\n## Recommended Routing\n\n';
  md += '| Task | Recommended | Original | Quality Diff | Cost Saving (USD) | Decision |\n';
  md += '|---:|:---|:---|---:|---:|:---|\n';

  for (const task of BOOTH_DESIGN_TASKS) {
    const rec = routing[task.id];
    if (!rec) continue;
    md += `| ${task.id} | ${rec.recommendedModel.split('/')[1] || rec.recommendedModel} | ${rec.originalModel.split('/')[1] || rec.originalModel} | ${rec.qualityDiff.toFixed(2)} | $${rec.costSaving.toFixed(6)} | ${rec.routingDecision} |\n`;
  }

  // ── Summary ──
  md += '\n## Summary\n\n';
  md += '| Metric';
  for (const label of modelLabels) md += ` | ${label}`;
  md += ' |\n|' + '---|'.repeat(1 + models.length) + '\n';

  for (const key of ['avgQuality', 'totalCost', 'avgCostPerQuality']) {
    const label = key === 'avgQuality' ? 'Average Quality (out of 10)'
      : key === 'totalCost' ? 'Total Cost (USD)'
      : 'Avg Cost / Quality Point (USD)';
    md += `| ${label}`;
    for (const model of models) {
      const s = summary.models[model];
      if (!s) { md += ' | -'; continue; }
      const v = s[key];
      md += key === 'avgQuality' ? ` | ${v.toFixed(2)}` : ` | $${v.toFixed(6)}`;
    }
    md += ' |\n';
  }

  // Cost ratio
  if (models.length >= 2) {
    const gpt4o = summary.models['openai/gpt-4o'];
    const deepseek = summary.models['deepseek/deepseek-v4-flash'];
    if (gpt4o && deepseek) {
      const cpqRatio = gpt4o.avgCostPerQuality / deepseek.avgCostPerQuality;
      md += `\n**Quality-adjusted cost ratio (gpt-4o / deepseek): ${cpqRatio.toFixed(2)}x**\n`;
    }
  }

  return md;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseBoothOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`);
    if (key === '--out') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --out');
      options['--out'] = value;
    } else if (key === '--model') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('Missing value for --model');
      options['--model'] = value;
    } else throw new Error(`Unknown option: ${key}`);
  }
  return options;
}

export function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (!command) throw new Error('Usage: booth-design-bench.mjs benchmark|routing|quality [--out <file.md>] [--model <model>]');

  if (command === 'benchmark') {
    const opts = parseBoothOptions(rest);
    const report = boothBenchmarkMarkdown();
    if (opts['--out']) fs.writeFileSync(opts['--out'], report, 'utf8');
    console.log(report);
  } else if (command === 'routing') {
    const opts = parseBoothOptions(rest);
    const { results } = boothBenchmark();
    const routing = recommendedRouting(results);
    let md = '# Booth Design Routing Recommendations\n\n';
    md += '| Task | Recommended | Original | Quality Diff | Cost Saving (USD) | Decision |\n';
    md += '|---:|:---|:---|---:|---:|:---|\n';
    for (const [taskId, rec] of Object.entries(routing)) {
      const task = BOOTH_DESIGN_TASKS.find(t => t.id === taskId);
      md += `| ${taskId} (${task?.title ?? ''}) | ${rec.recommendedModel.split('/')[1]} | ${rec.originalModel.split('/')[1]} | ${rec.qualityDiff.toFixed(2)} | $${rec.costSaving.toFixed(6)} | ${rec.routingDecision} |\n`;
    }
    if (opts['--out']) fs.writeFileSync(opts['--out'], md, 'utf8');
    console.log(md);
  } else if (command === 'quality') {
    const opts = parseBoothOptions(rest);
    const model = opts['--model'] || 'openai/gpt-4o';
    const qualityData = BOOTH_QUALITY_FIXTURES[model];
    if (!qualityData) throw new Error(`Unknown model: ${model}. Available: ${Object.keys(BOOTH_QUALITY_FIXTURES).join(', ')}`);
    let md = `# Quality Scores for ${model}\n\n`;
    md += '| Task ID | Title | Category | Quality Score |\n';
    md += '|---:|:---|:---|---:|\n';
    for (const task of BOOTH_DESIGN_TASKS) {
      const score = qualityData[task.id];
      md += `| ${task.id} | ${task.title} | ${task.category} | ${score.toFixed(1)} |\n`;
    }
    if (opts['--out']) fs.writeFileSync(opts['--out'], md, 'utf8');
    console.log(md);
  } else throw new Error(`Unknown command: ${command}. Use benchmark, routing, or quality.`);
}

if (isEntry(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
