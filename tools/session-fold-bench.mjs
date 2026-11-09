#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession, fold, stats, estimateTokens } from './session-fold.mjs';
import { isEntry } from './is-entry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SYNTHETIC_PATH = path.resolve(HERE, '../tests/fixtures/session-fold/synthetic-booth-spec.md');
export const DEFAULT_PRICE = Object.freeze({
  name: 'generic-relative', input: 1.0, cacheRead: 0.1, cacheWrite: 1.25,
  source: 'assumption (generic ratios; not verified against a live price page)', fetched: '2026-11-10',
});
const MODEL_DATE = '2026-11-10';
const PREFIX = 'Stable session prefix: system instructions and fixed project specifications.\n';

export function splitSegments(text) {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n[\t ]*\n+/).map(x => x.trim()).filter(Boolean);
  return paragraphs.flatMap(paragraph => {
    const pieces = [];
    for (let i = 0; i < paragraph.length; i += 1500) pieces.push(paragraph.slice(i, i + 1500));
    return pieces;
  });
}

function resolveFiles({ files, synthetic }) {
  const selected = synthetic ? [SYNTHETIC_PATH] : files;
  if (!selected?.length) throw new Error('one of --files or --synthetic is required');
  return selected.map(file => path.resolve(file));
}

export function corpusReport(options) {
  const rows = resolveFiles(options).map(file => {
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
    const text = fs.readFileSync(file, 'utf8');
    return { path: file, bytes: Buffer.byteLength(text), chars: text.length, segments: splitSegments(text).length, tokensEstimate: estimateTokens(text) };
  });
  return { files: rows, total: rows.reduce((a, x) => ({ bytes: a.bytes + x.bytes, chars: a.chars + x.chars, segments: a.segments + x.segments, tokensEstimate: a.tokensEstimate + x.tokensEstimate }), { bytes: 0, chars: 0, segments: 0, tokensEstimate: 0 }) };
}

function positiveInts(value, label) {
  const values = value.map(Number);
  if (!values.length || values.some(x => !Number.isInteger(x) || x <= 0)) throw new Error(`${label} must contain positive integers`);
  return values;
}
function rates(value) {
  const values = value.map(Number);
  if (!values.length || values.some(x => !Number.isFinite(x) || x < 0 || x > 1)) throw new Error('hit-rates must be numbers from 0 to 1');
  return values;
}
function stale(price) {
  const age = (Date.parse(`${MODEL_DATE}T00:00:00Z`) - Date.parse(`${price.fetched}T00:00:00Z`)) / 86400000;
  return !Number.isFinite(age) || age > 30;
}
function money(tokens, coefficient, input) { return tokens / 1_000_000 * coefficient * input; }

export function measureCase(segments, { turns, hitRate, keepRecent, k, foldEvery = 1, price = DEFAULT_PRICE }) {
  if (!Number.isInteger(foldEvery) || foldEvery < 1) throw new Error('fold-every must be a positive integer');
  const prefixTokens = estimateTokens(PREFIX);
  let aInput = 0, aCost = 0, bInput = 0, bCost = 0;
  let previousCount = 0;
  let previousFoldedCount = 0;
  let lastFoldCount = 0;
  let foldedIds = [];
  for (let turn = 1; turn <= turns; turn++) {
    const count = Math.floor(segments.length * turn / turns);
    const current = segments.slice(0, count);
    const incrementTokens = current.slice(previousCount).reduce((n, x) => n + estimateTokens(x), 0);
    const originalTokens = current.reduce((n, x) => n + estimateTokens(x), 0);
    const baseTokens = prefixTokens + originalTokens;
    aInput += baseTokens;
    aCost += money(baseTokens - incrementTokens, price.cacheRead, price.input) + money(incrementTokens, price.cacheWrite, price.input);

    const before = createSession({ prefix: PREFIX, segments: current });
    const batchFold = foldEvery === 1 || count - lastFoldCount >= foldEvery;
    const after = batchFold
      ? fold(before, { keepRecent })
      : fold(before, { keepRecent: 0, targetIds: foldedIds });
    const foldedStats = stats(after);
    const foldedEntries = after.index.filter(x => x.state === 'folded');
    // A hit-rate fraction of turns is expected to search, with at most k originals
    // appended for each search. This is an expectation, so no random draw is needed.
    const expectedHits = Math.min(foldedEntries.length, k) * hitRate;
    const averageOriginal = foldedEntries.length ? foldedEntries.reduce((n, x) => n + x.tokens, 0) / foldedEntries.length : 0;
    const unfoldTokens = expectedHits * averageOriginal;
    const foldHappened = foldEvery === 1
      ? foldedEntries.length > previousFoldedCount
      : batchFold;
    // Replacing old segments invalidates the suffix after the stable prefix. Charge that
    // suffix as a write only on a fold turn, never on later turns.
    const bodyTokens = foldedStats.totalTokens - prefixTokens;
    const foldRewrite = foldHappened ? bodyTokens : 0;
    const bTurnInput = foldedStats.totalTokens + unfoldTokens;
    bInput += bTurnInput;
    bCost += money(prefixTokens, price.cacheRead, price.input)
      + money(foldHappened ? 0 : Math.max(0, bodyTokens - incrementTokens), price.cacheRead, price.input)
      + money((foldHappened ? foldRewrite : incrementTokens) + unfoldTokens, price.cacheWrite, price.input);
    previousCount = count;
    previousFoldedCount = foldedEntries.length;
    if (batchFold) {
      lastFoldCount = count;
      foldedIds = foldedEntries.map(x => x.id);
    }
  }
  return {
    inputReduction: aInput ? (aInput - bInput) / aInput : 0,
    costReduction: aCost ? (aCost - bCost) / aCost : 0,
    baselineInputTokens: aInput, foldInputTokens: bInput, baselineCost: aCost, foldCost: bCost,
  };
}

function pct(x) { return `${(x * 100).toFixed(1)}%`; }
export function costReport({ files, synthetic = false, turns = [50, 200, 1000], hitRates = [0.05, 0.2, 0.5], keepRecent = 10, k = 3, foldEvery = 1, priceFile }) {
  turns = positiveInts(turns, 'turns'); hitRates = rates(hitRates);
  if (!Number.isInteger(keepRecent) || keepRecent < 0) throw new Error('keep-recent must be a non-negative integer');
  if (!Number.isInteger(k) || k < 0) throw new Error('k must be a non-negative integer');
  if (!Number.isInteger(foldEvery) || foldEvery < 1) throw new Error('fold-every must be a positive integer');
  const paths = resolveFiles({ files, synthetic });
  const segments = paths.flatMap(file => {
    if (!fs.existsSync(file)) throw new Error(`file not found: ${file}`);
    return splitSegments(fs.readFileSync(file, 'utf8'));
  });
  let price = DEFAULT_PRICE;
  if (priceFile) price = { ...DEFAULT_PRICE, ...JSON.parse(fs.readFileSync(priceFile, 'utf8')) };
  for (const field of ['input', 'cacheRead', 'cacheWrite']) if (!Number.isFinite(Number(price[field])) || Number(price[field]) < 0) throw new Error(`invalid price field: ${field}`);
  const rows = turns.flatMap(t => hitRates.map(h => ({ turns: t, hitRate: h, ...measureCase(segments, { turns: t, hitRate: h, keepRecent, k, foldEvery, price }) })));
  const lines = [
    '# Session fold cost sensitivity (measured calculation model; not an actual bill)', '',
    '## Assumptions', '',
    `- Price table: input $${price.input}/Mtok; cache read coefficient ${price.cacheRead}; cache write coefficient ${price.cacheWrite}`,
    `- Source: ${price.source}`,
    `- Fetched: ${price.fetched}${stale(price) ? ' — STALE: re-fetch' : ''}`,
    `- Turns: ${turns.join(', ')}`,
    `- Hit rates: ${hitRates.map(pct).join(', ')}`,
    `- keep-recent: ${keepRecent}; k: ${k}`,
    `- fold-every: ${foldEvery}`,
    '- Tokens: ceil(UTF-8 bytes / 3), not a model-specific tokenizer.',
    '- Baseline A: growing full history; prior content is cache read and increments are cache write.',
    '- Operation B: stable prefix is cache read; folded stubs replace old segments; expected search/unfold originals and fold rewrites are cache write.', '',
    '## Sensitivity table', '',
    '| Turns | Hit rate | Input token reduction | Input cost reduction | Difference from posted 71.1% | Fold every |',
    '|---:|---:|---:|---:|---|---:|',
  ];
  for (const row of rows) {
    const relation = row.inputReduction > .711 ? 'higher' : row.inputReduction < .711 ? 'lower' : 'equal';
    lines.push(`| ${row.turns} | ${pct(row.hitRate)} | ${pct(row.inputReduction)} | ${pct(row.costReduction)} | ${relation} than posted 71.1% because this local deterministic corpus/model has its stated fold, cache, and expected-unfold assumptions. | ${foldEvery} |`);
  }
  return `${lines.join('\n')}\n`;
}

function parse(args) {
  const out = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) out._.push(arg);
    else if (arg === '--synthetic') out.synthetic = true;
    else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`missing value for ${arg}`); out[arg] = args[++i]; }
  }
  return out;
}
export function main(args = process.argv.slice(2)) {
  const o = parse(args), command = o._[0];
  const files = o['--files']?.split(',').filter(Boolean);
  if (command === 'corpus') console.log(JSON.stringify(corpusReport({ files, synthetic: o.synthetic }), null, 2));
  else if (command === 'cost') process.stdout.write(costReport({ files, synthetic: o.synthetic, turns: (o['--turns'] ?? '50,200,1000').split(','), hitRates: (o['--hit-rates'] ?? '0.05,0.2,0.5').split(','), keepRecent: Number(o['--keep-recent'] ?? 10), k: Number(o['--k'] ?? 3), foldEvery: Number(o['--fold-every'] ?? 1), priceFile: o['--price-file'] }));
  else throw new Error('usage: session-fold-bench.mjs corpus|cost --files <paths>|--synthetic');
}
if (isEntry(import.meta.url)) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
