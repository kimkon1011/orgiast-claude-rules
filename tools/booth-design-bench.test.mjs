import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BOOTH_DESIGN_TASKS,
  BOOTH_QUALITY_FIXTURES,
  BOOTH_QUALITY_CRITERIA,
  boothBenchmark,
  recommendedRouting,
  boothBenchmarkMarkdown,
  estimateBoothCost,
  classifyBoothTask,
  main,
} from './booth-design-bench.mjs';

const MODELS = Object.keys(BOOTH_QUALITY_FIXTURES);
const TASK_COUNT = 15;

// ---------------------------------------------------------------------------
// 1. BOOTH_DESIGN_TASKS validation
// ---------------------------------------------------------------------------
test('BOOTH_DESIGN_TASKS has 15 items with required fields', () => {
  assert.equal(BOOTH_DESIGN_TASKS.length, TASK_COUNT);
  for (const task of BOOTH_DESIGN_TASKS) {
    assert.ok(task.id, `Missing id in ${task.title}`);
    assert.ok(task.title, `Missing title in ${task.id}`);
    assert.ok(task.category, `Missing category in ${task.id}`);
    assert.ok(task.text, `Missing text in ${task.id}`);
    assert.ok(Number.isSafeInteger(task.minTokens) && task.minTokens > 0, `Invalid minTokens in ${task.id}`);
    assert.ok(Number.isSafeInteger(task.maxTokens) && task.maxTokens > 0, `Invalid maxTokens in ${task.id}`);
    assert.ok(task.maxTokens >= task.minTokens, `maxTokens < minTokens in ${task.id}`);
  }
  // All IDs unique
  const ids = BOOTH_DESIGN_TASKS.map(t => t.id);
  assert.equal(new Set(ids).size, TASK_COUNT);
});

// ---------------------------------------------------------------------------
// 2. boothBenchmark returns all task×model combinations
// ---------------------------------------------------------------------------
test('boothBenchmark returns 15 tasks × 3 models = 45 results', () => {
  const { results, summary } = boothBenchmark();
  assert.equal(results.length, TASK_COUNT * MODELS.length);
  assert.equal(results.length, 45);
  for (const r of results) {
    assert.ok(r.taskId);
    assert.ok(r.model);
    assert.ok(typeof r.qualityScore === 'number');
    assert.ok(typeof r.costUsd === 'number');
    assert.ok(typeof r.costPerQuality === 'number');
    assert.ok(r.costUsd > 0);
    assert.ok(r.qualityScore >= 0 && r.qualityScore <= 10);
  }
  // Summary has all models
  assert.equal(Object.keys(summary.models).length, MODELS.length);
});

// ---------------------------------------------------------------------------
// 3. Quality ordering: deepseek < kimi < gpt-4o (fixture assumption)
// ---------------------------------------------------------------------------
test('qualityScore order: deepseek < kimi < gpt-4o for all tasks', () => {
  const { results } = boothBenchmark();
  for (const task of BOOTH_DESIGN_TASKS) {
    const tResults = results.filter(r => r.taskId === task.id);
    const deepseek = tResults.find(r => r.model.includes('deepseek'));
    const kimi = tResults.find(r => r.model.includes('kimi'));
    const gpt4o = tResults.find(r => r.model.includes('gpt-4o'));
    assert.ok(deepseek && kimi && gpt4o, `Missing results for ${task.id}`);
    assert.ok(deepseek.qualityScore < kimi.qualityScore, `deepseek >= kimi for ${task.id}`);
    assert.ok(kimi.qualityScore < gpt4o.qualityScore, `kimi >= gpt-4o for ${task.id}`);
  }
});

// ---------------------------------------------------------------------------
// 4. costPerQuality: deepseek is cheapest
// ---------------------------------------------------------------------------
test('costPerQuality: deepseek < kimi < gpt-4o for all tasks', () => {
  const { results } = boothBenchmark();
  for (const task of BOOTH_DESIGN_TASKS) {
    const tResults = results.filter(r => r.taskId === task.id);
    const deepseek = tResults.find(r => r.model.includes('deepseek'));
    const kimi = tResults.find(r => r.model.includes('kimi'));
    const gpt4o = tResults.find(r => r.model.includes('gpt-4o'));
    assert.ok(deepseek && kimi && gpt4o);
    assert.ok(deepseek.costPerQuality < kimi.costPerQuality, `deepseek CPQ >= kimi for ${task.id}`);
    assert.ok(kimi.costPerQuality < gpt4o.costPerQuality, `kimi CPQ >= gpt-4o for ${task.id}`);
  }
});

// ---------------------------------------------------------------------------
// 5. recommendedRouting correctly identifies same_quality_cheaper
// ---------------------------------------------------------------------------
test('recommendedRouting detects same_quality_cheaper for tasks with ≤0.5 quality diff', () => {
  const { results } = boothBenchmark();
  const routing = recommendedRouting(results);
  const decisions = Object.values(routing);
  assert.equal(decisions.length, TASK_COUNT);

  // Check that some tasks get same_quality_cheaper (fixture expectation)
  const cheaperCount = decisions.filter(d => d.routingDecision === 'same_quality_cheaper').length;
  assert.ok(cheaperCount > 0, `No same_quality_cheaper found (got ${cheaperCount})`);

  // Check that quality_premium is also used (tasks where gpt-4o is clearly better)
  const premiumCount = decisions.filter(d => d.routingDecision === 'quality_premium').length;
  assert.ok(premiumCount > 0, `No quality_premium found (got ${premiumCount})`);

  // Validate structure
  for (const rec of decisions) {
    assert.ok(['same_quality_cheaper', 'quality_premium'].includes(rec.routingDecision));
    assert.ok(rec.recommendedModel);
    assert.ok(rec.originalModel);
    assert.ok(typeof rec.qualityDiff === 'number');
    assert.ok(typeof rec.costSaving === 'number');
  }
});

// ---------------------------------------------------------------------------
// 6. Cost savings are substantial when routing to cheaper models
// ---------------------------------------------------------------------------
test('recommendedRouting achieves >50% savings when quality diff ≤0.5', () => {
  const { results } = boothBenchmark();
  const routing = recommendedRouting(results);
  const cheapRoutes = Object.values(routing).filter(d => d.routingDecision === 'same_quality_cheaper');
  for (const rec of cheapRoutes) {
    const gpt4oCost = results.find(r => r.taskId === rec.taskId && r.model === 'openai/gpt-4o')?.costUsd;
    assert.ok(gpt4oCost, `Missing gpt-4o cost for ${rec.taskId}`);
    const savingsRate = rec.costSaving / gpt4oCost;
    assert.ok(savingsRate > 0.5, `Savings rate ${(savingsRate * 100).toFixed(1)}% ≤ 50% for ${rec.taskId}`);
    assert.ok(rec.qualityDiff <= 0.5, `Quality diff ${rec.qualityDiff} > 0.5 for ${rec.taskId}`);
  }
});

// ---------------------------------------------------------------------------
// 7. classifyBoothTask detects booth-related keywords
// ---------------------------------------------------------------------------
test('classifyBoothTask detects booth keywords and bumps to medium', () => {
  const boothTexts = [
    '展示会ブースの企画案を作成',
    'ブースのレイアウトを設計',
    'デザインコンセプトを提案',
    '予算案を項目別に作成',
    'キャッチコピーを5案作成',
    '施工指示書を作成',
    '来場者ターゲットを分析',
  ];
  for (const text of boothTexts) {
    const result = classifyBoothTask(text);
    assert.ok(result === 'medium' || result === 'complex', `"${text}" → ${result}, expected medium or complex`);
  }

  // Non-booth text should pass through unchanged
  assert.equal(classifyBoothTask('日付を抽出'), 'simple');
  assert.equal(classifyBoothTask('結果を説明'), 'medium');
});

// ---------------------------------------------------------------------------
// 8. CLI benchmark outputs Markdown
// ---------------------------------------------------------------------------
test('CLI benchmark outputs Markdown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x0026-cli-'));
  const outFile = path.join(dir, 'bench.md');
  const originalLog = console.log;
  const lines = [];
  console.log = line => lines.push(String(line));
  try {
    main(['benchmark', '--out', outFile]);
    assert.ok(lines.length > 0);
    const fullOutput = lines.join('\n');
    assert.match(fullOutput, /Booth Design Benchmark Report/);
    assert.match(fullOutput, /Quality Scores/);
    assert.match(fullOutput, /Cost per Task/);
    assert.match(fullOutput, /Cost per Quality Point/);
    assert.match(fullOutput, /Recommended Routing/);
    assert.match(fullOutput, /Summary/);
    // File written
    assert.ok(fs.existsSync(outFile));
    const fileContent = fs.readFileSync(outFile, 'utf8');
    assert.match(fileContent, /Booth Design Benchmark Report/);
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 9. Quality-adjusted cost ratio is approximately 12.5x (gpt-4o / deepseek)
//    based on the specification fixture prices ($2.50 vs $0.15 input, $10 vs $0.60 output)
//    and quality scores. The raw price ratio is 16.67x; quality adjustment
//    brings it to ~12.5x.
// ---------------------------------------------------------------------------
test('quality-adjusted cost ratio gpt-4o / deepseek is approximately 12.5x', () => {
  const { summary } = boothBenchmark();
  const gpt4o = summary.models['openai/gpt-4o'];
  const deepseek = summary.models['deepseek/deepseek-v4-flash'];
  assert.ok(gpt4o && deepseek, 'Missing model summaries');
  const ratio = gpt4o.avgCostPerQuality / deepseek.avgCostPerQuality;
  // The fixture prices give a raw cost ratio of 16.67x; quality adjustment
  // (avg 8.47 / 6.37) brings it to ~12.5x. Assert within reasonable bounds.
  assert.ok(ratio > 8 && ratio < 18, `Ratio ${ratio.toFixed(2)}x outside expected range [8, 18]`);
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
test('estimateBoothCost rejects unknown task', () => {
  assert.throws(() => estimateBoothCost('bd-99', 'simple'), /Unknown/);
});

test('classifyBoothTask passes through non-booth text', () => {
  assert.equal(classifyBoothTask('日付を抽出してください'), 'simple');
  assert.equal(classifyBoothTask('議事録を要約'), 'medium');
  assert.equal(classifyBoothTask('アーキテクチャを設計'), 'complex');
});

test('CLI routing command outputs Markdown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x0026-routing-'));
  const outFile = path.join(dir, 'routing.md');
  const originalLog = console.log;
  const lines = [];
  console.log = line => lines.push(String(line));
  try {
    main(['routing', '--out', outFile]);
    const fullOutput = lines.join('\n');
    assert.match(fullOutput, /Booth Design Routing Recommendations/);
    assert.match(fullOutput, /same_quality_cheaper|quality_premium/);
    assert.ok(fs.existsSync(outFile));
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI quality command outputs Markdown', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x0026-quality-'));
  const outFile = path.join(dir, 'quality.md');
  const originalLog = console.log;
  const lines = [];
  console.log = line => lines.push(String(line));
  try {
    main(['quality', '--model', 'openai/gpt-4o', '--out', outFile]);
    const fullOutput = lines.join('\n');
    assert.match(fullOutput, /Quality Scores for openai\/gpt-4o/);
    assert.ok(fs.existsSync(outFile));
  } finally {
    console.log = originalLog;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI errors on unknown command', () => {
  assert.throws(() => main(['invalid-cmd']), /Unknown command/);
});

test('BOOTH_QUALITY_CRITERIA has correct structure', () => {
  assert.ok(Array.isArray(BOOTH_QUALITY_CRITERIA.criteria));
  assert.equal(BOOTH_QUALITY_CRITERIA.criteria.length, 4);
  assert.equal(BOOTH_QUALITY_CRITERIA.maxScore, 10);
  assert.ok(BOOTH_QUALITY_CRITERIA.scoringGuide.coverage);
  assert.ok(BOOTH_QUALITY_CRITERIA.scoringGuide.specificity);
  assert.ok(BOOTH_QUALITY_CRITERIA.scoringGuide.practicality);
  assert.ok(BOOTH_QUALITY_CRITERIA.scoringGuide.originality);
});
