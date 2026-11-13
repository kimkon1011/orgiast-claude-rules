import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classifyTask, routeTask, estimateCost, loadTest, benchmarkMarkdown, main as routerMain } from './model-router.mjs';
import { runBenchmark, renderMarkdown, main as cacheMain } from './prefix-cache-bench.mjs';

test('Japanese and English classification, complex precedence and uncertain fallback', () => {
  for (const [text, expected] of [
    ['分類してください', 'simple'], ['Extract dates', 'simple'], ['定型応答', 'simple'],
    ['要約してください', 'medium'], ['Explain the result', 'medium'],
    ['設計してください', 'complex'], ['Creative strategy', 'complex'],
    ['抽出システムを設計', 'complex'], ['分類して要約', 'unknown'],
    ['', 'unknown'], ['!?🚀<>', 'unknown'], ['x'.repeat(100001) + '設計', 'unknown'],
  ]) assert.equal(classifyTask(text), expected, text.slice(0, 40));
  assert.throws(() => classifyTask(null), /string/);
});
test('gateway models, fallback and configurable non-Claude complex model', () => {
  assert.equal(routeTask('分類').model, 'deepseek/deepseek-v4-flash');
  const fallback = routeTask('');
  assert.equal(fallback.route, 'medium');
  assert.equal(fallback.provider, 'openrouter');
  assert.equal(fallback.model, 'moonshotai/kimi-k3');
  assert.equal(fallback.classificationCorrect, null);
  assert.equal(routeTask('設計').model, 'openai/gpt-4o');
  const custom = routeTask('設計', { complexModel: 'example/model' });
  assert.equal(custom.estimatedCostUsd, null);
  assert.equal(custom.estimatedLatencyMs, null);
  assert.equal(routeTask('設計', { complexModel: 'example/model', complexPricing: { inputPerMillion: 1, outputPerMillion: 2 } }).estimatedCostUsd, 0.001);
  for (const model of ['anthropic/claude-opus-4', 'other/claude-test', 'auto', 'openrouter/auto\n']) {
    assert.throws(() => routeTask('設計', { complexModel: model }), /non-Claude/);
  }
});
test('cost accounts for both token directions and rejects invalid inputs', () => {
  assert.equal(estimateCost('simple', 1000), 0.00015);
  assert.equal(estimateCost('medium', { input: 1000, output: 1000 }), 0.002);
  assert.equal(estimateCost('complex', { input: 1000, output: 1000 }), 0.0125);
  assert.equal(estimateCost('unknown', 1000), 0.0005);
  assert.equal(estimateCost('simple', 0), 0);
  for (const tokens of [-1, NaN, Infinity, 1.2, '100', {}, { input: 1, output: -1 }]) assert.throws(() => estimateCost('simple', tokens));
  for (const route of ['bad', 'toString', '__proto__']) assert.throws(() => estimateCost(route, 1));
});
test('load test uses nearest rank and separates simulated inference from local timing', () => {
  const result = loadTest(100);
  assert.deepEqual([result.p50, result.p95, result.p99], [1200, 2000, 2000]);
  assert.equal(Object.values(result.routes).reduce((a, b) => a + b), 100);
  assert.equal(result.classificationAccuracy, 1);
  assert.ok(result.routingLatencyMs.p50 >= 0);
  assert.ok(result.routingLatencyMs.p99 >= result.routingLatencyMs.p50);
  assert.equal(loadTest(1, { tasks: [{ text: '分類', expectedRoute: 'complex' }] }).classificationAccuracy, 0);
  assert.equal(loadTest(1, { tasks: [{ text: '分類' }] }).classificationAccuracy, null);
  for (const count of [0, -1, NaN, Infinity, 1.1, 100001]) assert.throws(() => loadTest(count));
  assert.throws(() => loadTest(1, { tasks: [] }));
  assert.match(benchmarkMarkdown(), /simulation/);
});
test('opt-in logs retain metrics and correctness without task text', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x0010-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'log.jsonl');
  routeTask('機密顧客を分類', { logFile, expectedRoute: 'simple' });
  const log = fs.readFileSync(logFile, 'utf8');
  assert.equal(JSON.parse(log).classificationCorrect, true);
  assert.ok(!log.includes('機密'));
});
test('cache fixtures and mandatory offline guard', () => {
  const result = runBenchmark({ dryRun: true });
  assert.deepEqual(result.rows.map(r => [r.ttftMs, r.cacheHitRatio, r.costUsd]), [[150, .85, .0012], [300, .45, .0035], [800, 0, .008]]);
  assert.deepEqual(result.rows.map(r => r.ttftSavingMs), [650, 500, 0]);
  assert.equal(result.actualBilledUsd, 0);
  assert.match(renderMarkdown(result), /not measured billing/);
  assert.throws(() => runBenchmark(), /dry-run/);
  assert.throws(() => runBenchmark({ dryRun: true, provider: 'anthropic' }), /prohibited/);
});
test('CLI outputs, errors and Markdown files work with network disabled', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'x0010-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  t.after(() => { globalThis.fetch = originalFetch; console.log = originalLog; });
  globalThis.fetch = () => { throw new Error('Network forbidden'); };
  const run = (file, args) => {
    const lines = [];
    console.log = line => lines.push(String(line));
    try {
      (file.includes('prefix-cache') ? cacheMain : routerMain)(args);
      return { status: 0, stdout: lines.join('\n') };
    } catch (error) { return { status: 1, stderr: error.message }; }
    finally { console.log = originalLog; }
  };
  const out = path.join(dir, 'report.md');
  for (const [file, args] of [
    ['./model-router.mjs', ['classify', '要約']], ['./model-router.mjs', ['estimate', '--route', 'simple', '--tokens', '1000']],
    ['./model-router.mjs', ['load-test', '--count', '100']], ['./model-router.mjs', ['benchmark', '--out', out]],
    ['./prefix-cache-bench.mjs', ['--dry-run', '--out', out]],
  ]) { const result = run(file, args); assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout.length); }
  assert.match(fs.readFileSync(out, 'utf8'), /repeated_system/);
  for (const [file, args] of [
    ['./prefix-cache-bench.mjs', []], ['./prefix-cache-bench.mjs', ['--dry-run', '--provider', 'anthropic']],
    ['./model-router.mjs', ['load-test', '--count', '-1']], ['./model-router.mjs', ['benchmark', '--out']],
    ['./model-router.mjs', ['load-test', '--wrong']],
  ]) assert.equal(run(file, args).status, 1);
});
