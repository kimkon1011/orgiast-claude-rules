import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  extractCommonPrefix, estimateTokens, measureTTFT, reportCacheEfficiency, demo, readCacheState, writeCacheState, cacheStorePath,
} from './kv-cache-prefix-gateway.mjs';

// ---------- Prefix extraction ----------

test('extractCommonPrefix returns full prefix when all match', () => {
  const requests = [
    { system: 'あなたは展示会ブースのプロジェクトマネージャーです。ガイドラインに従って提案を生成してください。' },
    { system: 'あなたは展示会ブースのプロジェクトマネージャーです。ガイドラインに従って提案を生成してください。' },
    { system: 'あなたは展示会ブースのプロジェクトマネージャーです。ガイドラインに従って提案を生成してください。' },
  ];
  const { prefix, common } = extractCommonPrefix(requests);
  assert.equal(prefix, requests[0].system);
  assert.equal(common, true);
});

test('extractCommonPrefix returns partial prefix when suffix differs', () => {
  const requests = [
    { system: 'あなたは展示会ブースのプロジェクトマネージャーです。案件Aの提案を生成せよ。' },
    { system: 'あなたは展示会ブースのプロジェクトマネージャーです。案件Bの提案を生成せよ。' },
  ];
  const { prefix, common } = extractCommonPrefix(requests);
  assert.ok(prefix.includes('あなたは展示会ブースのプロジェクトマネージャーです。'));
  assert.ok(!prefix.includes('案件A'));
  assert.ok(!prefix.includes('案件B'));
  assert.equal(common, true);
});

test('extractCommonPrefix returns empty when no shared prefix', () => {
  const requests = [
    { system: 'Hello, how are you?' },
    { system: '全く異なるシステムプロンプト' },
  ];
  const { prefix, common } = extractCommonPrefix(requests, { minChars: 10 });
  assert.ok(prefix.length < 10);
  assert.equal(common, false);
});

test('extractCommonPrefix handles empty requests', () => {
  assert.deepEqual(extractCommonPrefix([]), { prefix: '', common: true });
  assert.deepEqual(extractCommonPrefix(), { prefix: '', common: true });
});

test('extractCommonPrefix handles string input', () => {
  const { prefix } = extractCommonPrefix(['common-start-A', 'common-start-B']);
  assert.equal(prefix, 'common-start-');
});

test('extractCommonPrefix handles messages array', () => {
  const requests = [
    { messages: [{ role: 'system', content: '共通部分A' }] },
    { messages: [{ role: 'system', content: '共通部分B' }] },
  ];
  const { prefix } = extractCommonPrefix(requests);
  assert.equal(prefix, '共通部分');
});

test('extractCommonPrefix minChars gate', () => {
  const requests = [
    { system: 'ab' },
    { system: 'ac' },
  ];
  const { common } = extractCommonPrefix(requests, { minChars: 5 });
  assert.equal(common, false);
});

// ---------- Token estimation ----------

test('estimateTokens rough count', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcdefgh'), 2);
  assert.equal(estimateTokens(''), 0);
  assert.ok(estimateTokens('日本語のテキスト') > 0);
});

// ---------- TTFT measurement ----------

test('measureTTFT computes correct reduction', () => {
  const results = [
    { id: 'first', startedAt: 0, firstTokenAt: 4000, completedAt: 6000 },
    { id: 'second', startedAt: 0, firstTokenAt: 500, completedAt: 3000 },
    { id: 'third', startedAt: 0, firstTokenAt: 450, completedAt: 2800 },
  ];
  const ttft = measureTTFT(results);
  assert.equal(ttft.firstTtftMs, 4000);
  assert.equal(ttft.lastTtftMs, 450);
  assert.equal(ttft.requestCount, 3);
  // (4000 - 450) / 4000 = 0.8875 → 88.8%
  assert.equal(ttft.ttftReduction, 88.8);
});

test('measureTTFT returns empty for empty input', () => {
  assert.deepEqual(measureTTFT([]), {});
});

test('measureTTFT averages TTFT', () => {
  const results = [
    { startedAt: 100, firstTokenAt: 500 },
    { startedAt: 200, firstTokenAt: 700 },
  ];
  const ttft = measureTTFT(results);
  assert.equal(ttft.avgTtftMs, 450); // (400 + 500) / 2
});

// ---------- Cache efficiency ----------

test('reportCacheEfficiency computes savings', () => {
  const results = [
    { id: 'first', inputTokens: 5000, isFirst: true },
    { id: 'second', inputTokens: 5000, isFirst: false },
    { id: 'third', inputTokens: 5000, isFirst: false },
  ];
  const eff = reportCacheEfficiency(results);
  assert.equal(eff.requests, 3);
  assert.equal(eff.totalTokens, 15000);
  // 3 reqs × 5000 tokens, firstPrefix ~= round(5000*0.7) = 3500
  // suffix per req = 1500, totalSuffix = 4500
  // uncached = firstPrefix(3500) + totalSuffix(4500) = 8000
  // cached = totalPrefix(10500) - firstPrefix(3500) = 7000
  assert.equal(eff.uncachedTokens, 8000);
  assert.equal(eff.cachedTokens, 7000);
  assert.ok(eff.savingsPercent > 0);
});

test('reportCacheEfficiency returns zeros for empty', () => {
  const eff = reportCacheEfficiency([]);
  assert.equal(eff.requests, 0);
  assert.equal(eff.savingsPercent, 0);
});

test('reportCacheEfficiency cost calculation', () => {
  const results = [
    { id: 'first', inputTokens: 1_000_000, isFirst: true },
  ];
  const eff = reportCacheEfficiency(results, { promptCostPerM: 0.15, cachedCostPerM: 0.015 });
  assert.equal(eff.costUncached, 0.15);
  assert.equal(eff.costCached, 0.15); // Single request, no caching
  assert.equal(eff.savingsPercent, 0);
});

// ---------- Demo ----------

test('demo returns expected structure for booth-proposal', () => {
  const result = demo('booth-proposal');
  assert.ok(result.scenario.includes('展示会'));
  assert.equal(result.results.length, 3);
  assert.ok(result.ttft.ttftReduction > 50);
  assert.ok(result.efficiency.cachedHitRate > 50);
  assert.ok(result.sharedPrefixSnippet.includes('デザインガイドライン'));
});

test('demo returns expected structure for multiple-projects', () => {
  const result = demo('multiple-projects');
  assert.equal(result.results.length, 5);
  assert.ok(result.ttft.ttftReduction > 70);
});

// ---------- Cache state persistence ----------

// 並列実行による env 競合を避けるため、直接 store パスを操作するテストに変更
test('readCacheState returns empty for missing file', () => {
  const storePath = cacheStorePath();
  let hadState = false;
  let backup = null;
  try {
    if (fs.existsSync(storePath)) {
      hadState = true;
      backup = fs.readFileSync(storePath, 'utf8');
      fs.rmSync(storePath);
    }
    assert.deepEqual(readCacheState(), {});
  } finally {
    if (hadState && backup !== null) {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, backup, 'utf8');
    }
  }
});

test('writeCacheState and readCacheState round-trip', () => {
  const storePath = cacheStorePath();
  let hadState = false;
  let backup = null;
  try {
    if (fs.existsSync(storePath)) {
      hadState = true;
      backup = fs.readFileSync(storePath, 'utf8');
    }
    writeCacheState({ 'prefix-hash-abc': { cachedAt: 1000, hitCount: 3 } });
    const state = readCacheState();
    assert.ok(state['prefix-hash-abc']);
    assert.equal(state['prefix-hash-abc'].hitCount, 3);
  } finally {
    if (hadState && backup !== null) {
      fs.writeFileSync(storePath, backup, 'utf8');
    } else {
      try { fs.rmSync(storePath); } catch {}
    }
  }
});
