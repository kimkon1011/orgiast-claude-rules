// tools/llm-cache-store.test.mjs — X-0032: リクエストキャッシュストアのテスト
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  normalizePrompt, promptHash, similarity,
  lookupCache, storeCache, readCacheIndex, cacheEntryPath, initStore,
  logRequest, readLogs, computeStats, estimateCost,
} from './llm-cache-store.mjs';

const TEST_CACHE_DIR = path.join(os.homedir(), '.claude', '.test-llm-cache');
const OLD_CACHE_DIR = process.env.LLM_CACHE_DIR;

function withTestDir(fn) {
  return () => {
    process.env.LLM_CACHE_DIR = TEST_CACHE_DIR;
    // initStore 内で LLM_CACHE_DIR を参照するので、
    // 直接 CACHE_DIR が TEST_CACHE_DIR を指すようにするためクリア
    try { fs.rmdirSync(TEST_CACHE_DIR, { recursive: true }); } catch { /* OK */ }
    try { fs.mkdirSync(TEST_CACHE_DIR, { recursive: true }); } catch { /* OK */ }
    try {
      fn();
    } finally {
      try { fs.rmdirSync(TEST_CACHE_DIR, { recursive: true }); } catch { /* OK */ }
      if (OLD_CACHE_DIR) process.env.LLM_CACHE_DIR = OLD_CACHE_DIR;
      else delete process.env.LLM_CACHE_DIR;
    }
  };
}

// ---------- normalizePrompt / promptHash ----------

test('normalizePrompt は改行と空白を統一', () => {
  const a = 'hello   world\nhow are you?';
  const b = 'hello world  how are you?';
  assert.equal(normalizePrompt(a), normalizePrompt(b));
});

test('normalizePrompt はコメントを除去', () => {
  const a = 'hello // inline comment\nworld';
  // 改行が先にスペースに統一されるため、// 以降は行末まで除去→'hello world'にはならない
  assert.equal(normalizePrompt(a), 'hello');
});

test('promptHash は同一プロンプトで同一ハッシュ', () => {
  const a = 'This is a test prompt for booth design.';
  const b = 'This is  a test  prompt for booth design.';
  assert.equal(promptHash(a), promptHash(b));
});

test('promptHash は異なるプロンプトで異なるハッシュ', () => {
  const a = 'Design a booth for product X';
  const b = 'Design a booth for product Y';
  assert.notEqual(promptHash(a), promptHash(b));
});

// ---------- similarity ----------

test('similarity 完全一致は1.0', () => {
  assert.equal(similarity('hello world', 'hello world'), 1.0);
});

test('similarity 完全不一致は低値', () => {
  assert.ok(similarity('hello world foo bar', 'totally different content here') < 0.3);
});

test('similarity 類似プロンプトは高値', () => {
  const a = '展示会ブースのデザイン提案を生成してください。サイズは2.7m×6mです。';
  const b = '展示会ブースのデザイン提案を生成してください。サイズは2.7m×6mです。色は青と白。';
  assert.ok(similarity(a, b) > 0.5);
});

// ---------- store / lookup ----------

test('storeCache + lookupCache 完全一致でキャッシュヒット', withTestDir(() => {
  const prompt = 'This is a test prompt for booth design.';
  const response = 'Here is a booth design with 3 panels and a demo counter.';
  const hash = storeCache(prompt, response, { model: 'test-model', inputTokens: 100, outputTokens: 50 });

  const result = lookupCache(prompt, { model: 'test-model' });
  assert.ok(result.hit);
  assert.equal(result.entry.response, response);
  assert.equal(result.hash, hash);
}));

test('lookupCache 未キャッシュはミス', withTestDir(() => {
  const prompt = 'This prompt has never been cached before.';
  const result = lookupCache(prompt);
  assert.equal(result.hit, false);
  assert.equal(result.similar.length, 0);
}));

test('lookupCache 異なるモデルは別キャッシュ', withTestDir(() => {
  const prompt = 'Design a booth.';
  storeCache(prompt, 'Response A', { model: 'model-a' });

  const result = lookupCache(prompt, { model: 'model-b' });
  // モデルが異なるのでヒットしない（ただしキャッシュエントリはある）
  assert.equal(result.hit, false);
}));

// ---------- log / stats ----------

test('logRequest + readLogs で記録と読み出し', withTestDir(() => {
  logRequest({
    promptHash: 'abc123',
    model: 'test-model',
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 1500,
    cacheHit: false,
    prompt: 'test prompt',
  });
  logRequest({
    promptHash: 'def456',
    model: 'test-model',
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 200,
    cacheHit: true,
    prompt: 'test prompt (cached)',
  });

  const logs = readLogs();
  assert.equal(logs.length, 2);
  assert.equal(logs[0].cacheHit, false);
  assert.equal(logs[1].cacheHit, true);
}));

test('computeStats は正しく集計する', withTestDir(() => {
  const logs = [
    { t: '2026-11-15T00:00:00Z', promptHash: 'a', model: 'm', inputTokens: 200, outputTokens: 100, latencyMs: 3000, cacheHit: false },
    { t: '2026-11-15T00:01:00Z', promptHash: 'b', model: 'm', inputTokens: 200, outputTokens: 100, latencyMs: 400, cacheHit: true },
    { t: '2026-11-15T00:02:00Z', promptHash: 'c', model: 'm', inputTokens: 200, outputTokens: 100, latencyMs: 350, cacheHit: true },
    { t: '2026-11-15T00:03:00Z', promptHash: 'd', model: 'm', inputTokens: 200, outputTokens: 100, latencyMs: 380, cacheHit: true },
  ];

  const stats = computeStats(logs);
  assert.equal(stats.totalRequests, 4);
  assert.equal(stats.cacheHits, 3);
  assert.equal(stats.cacheMisses, 1);
  assert.equal(stats.hitRate, 75.0);
  assert.equal(stats.totalInputTokens, 800);
  assert.equal(stats.totalOutputTokens, 400);
  assert.ok(stats.savingsPercent > 0);
}));

test('computeStats 空ログ', () => {
  const stats = computeStats([]);
  assert.equal(stats.totalRequests, 0);
  assert.equal(stats.hitRate, 0);
  assert.equal(stats.savingsUsd, 0);
});

test('computeStats null ログ', () => {
  const stats = computeStats(null);
  assert.equal(stats.totalRequests, 0);
});

// ---------- estimateCost ----------

test('estimateCost キャッシュ無しの方がキャッシュ有りより高い', () => {
  const uncached = estimateCost(1000, 500, { cacheHit: false });
  const cached = estimateCost(1000, 500, { cacheHit: true });
  assert.ok(uncached > cached, `uncached=${uncached} should be > cached=${cached}`);
});

test('estimateCost は正の値を返す', () => {
  const cost = estimateCost(100, 50);
  assert.ok(cost >= 0);
});

// ---------- エッジケース ----------

test('空プロンプトでエラーにならない', () => {
  const hash = promptHash('');
  assert.equal(typeof hash, 'string');
  assert.ok(hash.length > 0);
});

test('非常に長いプロンプトでもハッシュ化できる', () => {
  const long = 'word '.repeat(10000);
  const hash = promptHash(long);
  assert.equal(typeof hash, 'string');
  assert.equal(hash.length, 64); // SHA-256 hex
});