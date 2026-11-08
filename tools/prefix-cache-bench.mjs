#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { parseOptions, validateModel } from './model-router.mjs';

export function runBenchmark({ dryRun = false, provider = 'openrouter', model = 'openai/gpt-4o' } = {}) {
  if (!dryRun) throw new Error('Only --dry-run is implemented; no API calls are available');
  if (provider !== 'openrouter') throw new Error('Only openrouter is supported; anthropic is prohibited');
  validateModel(model);
  return { mode: 'simulation', provider, model, actualBilledUsd: 0, rows: [
    { workload: 'repeated_system', coldTtftMs: 800, ttftMs: 150, inputTokens: 10000, cachedTokens: 8500, costUsd: 0.0012 },
    { workload: 'similar_context', coldTtftMs: 800, ttftMs: 300, inputTokens: 10000, cachedTokens: 4500, costUsd: 0.0035 },
    { workload: 'unique', coldTtftMs: 800, ttftMs: 800, inputTokens: 10000, cachedTokens: 0, costUsd: 0.0080 },
  ].map(row => ({ ...row, ttftSavingMs: row.coldTtftMs - row.ttftMs, cacheHitRatio: row.cachedTokens / row.inputTokens })) };
}
export function renderMarkdown(result) {
  return `# Prefix caching benchmark (dry-run / simulation)\n\nProvider: ${result.provider}; model label: ${result.model}. No API calls. Actual billed cost: $0.\nAll values are fixtures independent of model pricing. Cold TTFT 800ms and 10,000 input tokens are illustrative assumptions. Costs below are supplied post-discount mock values, not measured billing.\n\n| Workload | Cold TTFT ms | Warm TTFT ms | Saving ms | Cached/input tokens | Cache hit | Mock discounted USD |\n|---|---:|---:|---:|---:|---:|---:|\n${result.rows.map(r => `| ${r.workload} | ${r.coldTtftMs} | ${r.ttftMs} | ${r.ttftSavingMs} | ${r.cachedTokens}/${r.inputTokens} | ${(r.cacheHitRatio * 100).toFixed(0)}% | $${r.costUsd.toFixed(4)} |`).join('\n')}\n\nWorkloads: repeated_system shares the complete system prefix; similar_context shares part of a long prefix; unique shares no prefix. This offline tool does not submit workload prompts.\n`;
}
// Future authorized measurement: construct paired cold/warm prompts, stream through
// OpenRouter, measure request-start to first content token (not headers/role events),
// read cached/input token counts and usage.cost, repeat trials and report distributions.
// Keep model, token counts, prefix length, TTL, trial order and provider routing fixed.
// This is a measurement plan only; intentionally no transport implementation.
export function main(args = process.argv.slice(2)) {
  const opts = parseOptions(args, ['--dry-run', '--provider', '--model', '--out']);
  const report = renderMarkdown(runBenchmark({ dryRun: opts['--dry-run'], provider: opts['--provider'], model: opts['--model'] }));
  if (opts['--out']) fs.writeFileSync(opts['--out'], report);
  console.log(report);
}
if (isEntry(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
