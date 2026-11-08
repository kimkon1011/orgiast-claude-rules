#!/usr/bin/env node
// Offline routing only. Prices and inference latency are specification fixtures.
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { gatewayModel, routeCandidate } from './provider-routing.mjs';
import { isEntry } from './is-entry.mjs';

export const ROUTING_TABLE = Object.freeze(Object.fromEntries(Object.entries({
  simple: { model: gatewayModel('deepseek'), inputPerMillion: 0.15, outputPerMillion: 0.60, latencyMs: 500 },
  medium: { model: gatewayModel('kimi'), inputPerMillion: 0.50, outputPerMillion: 1.50, latencyMs: 1200 },
  complex: { model: 'openai/gpt-4o', inputPerMillion: 2.50, outputPerMillion: 10, latencyMs: 2000 },
}).map(([key, value]) => [key, Object.freeze(value)])));
const RULES = {
  simple: /分類|抽出|定型応答|仕分け|抜き出|\b(classify|classification|extract|extraction|template reply)\b/i,
  medium: /要約|推論|まとめ|説明|\b(summarize|summary|reasoning|explain)\b/i,
  complex: /設計|創造|創作|アーキテクチャ|戦略|トレードオフ|\b(design|architecture|creative|strategy)\b/i,
};
const hasRoute = route => Object.hasOwn(ROUTING_TABLE, route);
export function validateModel(model) {
  if (typeof model !== 'string' || !/^[a-z0-9._-]+\/[a-z0-9._:-]+$/i.test(model)
    || /anthropic|claude|opus|sonnet|haiku/i.test(model)) throw new Error('Use an explicit non-Claude OpenRouter model ID');
  return model;
}
function classification(text) {
  if (typeof text !== 'string') throw new TypeError('Task must be a string');
  // Bound regex work; oversized inputs remain conservative rather than hiding a late design instruction.
  if (text.length > 100000) return { classification: 'unknown', confidence: 0, reason: 'input_too_long' };
  const matches = Object.keys(RULES).filter(route => RULES[route].test(text));
  if (matches.includes('complex')) return { classification: 'complex', confidence: 0.9, reason: 'complex_keyword' };
  if (matches.length !== 1) return { classification: 'unknown', confidence: 0, reason: matches.length ? 'ambiguous' : 'no_match' };
  return { classification: matches[0], confidence: 0.8, reason: 'keyword' };
}
export function classifyTask(text) { return classification(text).classification; }
function tokenCounts(tokens) {
  const counts = typeof tokens === 'number' ? { input: tokens, output: 0 } : tokens;
  if (!counts || !Number.isSafeInteger(counts.input) || counts.input < 0
    || !Number.isSafeInteger(counts.output) || counts.output < 0) throw new Error('Tokens must be non-negative integers: number (input only) or { input, output }');
  return counts;
}
export function estimateCost(route, tokens, pricing) {
  if (route === 'unknown') route = 'medium';
  if (!hasRoute(route)) throw new Error('Invalid route');
  const rates = pricing ?? ROUTING_TABLE[route];
  for (const key of ['inputPerMillion', 'outputPerMillion']) {
    if (!Number.isFinite(rates[key]) || rates[key] < 0) throw new Error('Explicit non-negative pricing is required');
  }
  const { input, output } = tokenCounts(tokens);
  return (input * rates.inputPerMillion + output * rates.outputPerMillion) / 1e6;
}
export function routeTask(text, options = {}) {
  const start = performance.now();
  const info = classification(text);
  const route = info.classification === 'unknown' ? 'medium' : info.classification;
  const base = ROUTING_TABLE[route];
  const model = validateModel(route === 'complex' ? (options.complexModel ?? base.model) : base.model);
  const custom = model !== base.model;
  const pricing = custom ? options.complexPricing : base;
  const estimatedCostUsd = pricing ? estimateCost(route, options.tokens ?? 1000, pricing) : null;
  if (options.expectedRoute !== undefined && !['simple', 'medium', 'complex', 'unknown'].includes(options.expectedRoute)) throw new Error('Invalid expectedRoute');
  const result = {
    ...info, route, ...routeCandidate({ provider: 'openrouter', model }),
    estimatedCostUsd, estimatedLatencyMs: custom ? null : base.latencyMs,
    routingLatencyMs: performance.now() - start,
    classificationCorrect: options.expectedRoute === undefined ? null : info.classification === options.expectedRoute,
    mode: 'offline', pricingSource: custom ? (pricing ? 'caller' : 'unknown') : 'specification-fixture',
  };
  // Opt-in JSONL; never persist task text. Null correctness means no ground truth.
  if (options.logFile) fs.appendFileSync(options.logFile, JSON.stringify(result) + '\n');
  return result;
}
export const BENCHMARK_TASKS = Object.freeze([
  { text: '問い合わせを分類', expectedRoute: 'simple' },
  { text: '日付を抽出', expectedRoute: 'simple' },
  { text: '議事録を要約', expectedRoute: 'medium' },
  { text: '結果を説明', expectedRoute: 'medium' },
  { text: '提案の戦略を設計', expectedRoute: 'complex' },
  { text: 'creative architecture', expectedRoute: 'complex' },
  { text: 'こんにちは', expectedRoute: 'unknown' },
  { text: '分類して要約', expectedRoute: 'unknown' },
]);
export function loadTest(count, options = {}) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 100000) throw new Error('Count must be an integer from 1 to 100000');
  const tasks = options.tasks ?? BENCHMARK_TASKS;
  if (!Array.isArray(tasks) || !tasks.length) throw new Error('Tasks must not be empty');
  const latencies = [], routing = [], routes = { simple: 0, medium: 0, complex: 0 };
  let correct = 0, graded = 0, estimatedCostUsd = 0;
  for (let i = 0; i < count; i++) {
    const task = tasks[i % tasks.length];
    const row = routeTask(task.text, { ...options, expectedRoute: task.expectedRoute });
    if (row.estimatedLatencyMs === null || row.estimatedCostUsd === null) throw new Error('Load test requires default fixture models');
    latencies.push(row.estimatedLatencyMs); routing.push(row.routingLatencyMs); routes[row.route]++;
    estimatedCostUsd += row.estimatedCostUsd;
    if (row.classificationCorrect !== null) { graded++; correct += Number(row.classificationCorrect); }
  }
  const percentiles = values => {
    values.sort((a, b) => a - b);
    return Object.fromEntries([50, 95, 99].map(p => [`p${p}`, values[Math.ceil(values.length * p / 100) - 1]]));
  };
  return { count, mode: 'simulation', latencyUnit: 'ms', ...percentiles(latencies), routingLatencyMs: percentiles(routing), routes,
    estimatedCostUsd, classificationAccuracy: graded ? correct / graded : null, graded };
}
export function benchmarkMarkdown(count = 1000) {
  const result = loadTest(count);
  return `# Model router benchmark (simulation)\n\nSpecification fixture prices; no API calls or billed cost. Input 1000 / output 0 tokens per task.\n\n| Count | p50 ms | p95 ms | p99 ms | Estimated USD | Fixture classification accuracy |\n|---:|---:|---:|---:|---:|---:|\n| ${count} | ${result.p50} | ${result.p95} | ${result.p99} | ${result.estimatedCostUsd.toFixed(6)} | ${(result.classificationAccuracy * 100).toFixed(1)}% |\n\nLatency is simulated inference latency (nearest-rank percentiles). Accuracy uses ${BENCHMARK_TASKS.length} labeled smoke fixtures, not an independent quality evaluation. Local routing duration is measured separately by load-test.\n`;
}
export function parseOptions(args, allowed) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!allowed.includes(key) || Object.hasOwn(options, key)) throw new Error(`Invalid or duplicate option: ${key}`);
    if (key === '--dry-run') options[key] = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value: ${key}`);
      options[key] = value;
    }
  }
  return options;
}
export function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  if (command === 'classify') {
    if (rest.length !== 1) throw new Error('classify requires one quoted task');
    console.log(JSON.stringify(routeTask(rest[0], { complexModel: process.env.MODEL_ROUTER_COMPLEX_MODEL }), null, 2));
  } else if (command === 'estimate') {
    const opts = parseOptions(rest, ['--route', '--tokens']);
    console.log(JSON.stringify({ estimatedCostUsd: estimateCost(opts['--route'], Number(opts['--tokens'])), tokenBasis: 'input only', pricingSource: 'specification-fixture' }));
  } else if (command === 'load-test') {
    const opts = parseOptions(rest, ['--count']);
    console.log(JSON.stringify(loadTest(Number(opts['--count'] ?? 1000)), null, 2));
  } else if (command === 'benchmark') {
    const opts = parseOptions(rest, ['--out']);
    const report = benchmarkMarkdown();
    if (opts['--out']) fs.writeFileSync(opts['--out'], report);
    console.log(report);
  } else throw new Error('Usage: model-router.mjs classify "task" | estimate --route simple --tokens 1000 | load-test --count 1000 | benchmark [--out file.md]');
}
if (isEntry(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
