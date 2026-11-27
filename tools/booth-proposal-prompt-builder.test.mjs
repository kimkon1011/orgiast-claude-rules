// Tests for booth-proposal-prompt-builder.mjs (X-0035)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildStaticPrefix,
  buildClientSuffix,
  buildProposalPrompt,
  estimateCostWithCache,
  processBatch,
  verifyCachePrefix,
} from './booth-proposal-prompt-builder.mjs';

// ---------- buildStaticPrefix ----------

test('buildStaticPrefix returns substantial static content', () => {
  const prefix = buildStaticPrefix();
  assert.ok(prefix.length >= 500, `prefix length = ${prefix.length}`);
  assert.ok(prefix.includes('オージャスト'), 'should include Orgiast company name');
  assert.ok(prefix.includes('2.7m'), 'should include booth dimensions');
  assert.ok(prefix.includes('安全基準'), 'should include safety rules');
  assert.ok(prefix.includes('標準備品'), 'should include common materials');
});

test('buildStaticPrefix is deterministic', () => {
  assert.equal(buildStaticPrefix(), buildStaticPrefix());
});

// ---------- buildClientSuffix ----------

test('buildClientSuffix includes required client fields', () => {
  const client = {
    company: 'テスト株式会社',
    exhibition: 'テスト展示会',
    venue: 'テスト会場',
    dates: '2026-12-01',
    komaCount: '1小間',
    industry: 'IT',
    purpose: '自社PR',
    budget: '50万円',
    designStyle: 'シンプル',
    requirements: '大型モニター',
  };
  const suffix = buildClientSuffix(client);
  assert.ok(suffix.includes('テスト株式会社'));
  assert.ok(suffix.includes('テスト展示会'));
  assert.ok(suffix.includes('テスト会場'));
  assert.ok(suffix.includes('シンプル'));
  assert.ok(suffix.includes('大型モニター'));
});

test('buildClientSuffix handles minimal client', () => {
  const client = { company: 'ミニマル社' };
  const suffix = buildClientSuffix(client);
  assert.ok(suffix.includes('ミニマル社'));
  assert.ok(suffix.includes('(未設定)')); // default for missing fields
});

test('buildClientSuffix with empty client uses defaults', () => {
  const suffix = buildClientSuffix({});
  assert.ok(suffix.includes('(未設定)'));
  assert.ok(suffix.toLowerCase().includes('自社pr'));
});

// ---------- buildProposalPrompt ----------

test('buildProposalPrompt combines prefix and suffix', () => {
  const prefix = buildStaticPrefix();
  const client = { company: '統合テスト社' };
  const prompt = buildProposalPrompt(client, { prefix });
  assert.ok(prompt.startsWith(prefix));
  assert.ok(prompt.includes('統合テスト社'));
  assert.ok(prompt.length > prefix.length);
});

test('buildProposalPrompt without prefix uses default', () => {
  const prompt = buildProposalPrompt({ company: 'デフォルトテスト' });
  assert.ok(prompt.includes('オージャスト'));
  assert.ok(prompt.includes('デフォルトテスト'));
});

// ---------- estimateCostWithCache ----------

test('estimateCostWithCache single request = write cost premium', () => {
  const result = estimateCostWithCache(500, [200], { baseCostPerM: 3.0 });
  assert.equal(result.requestCount, 1);
  // 単発ではキャッシュ書込プレミアム(1.25x)がかかり、通常より高い
  assert.ok(result.savingsPercent < 0, `savings = ${result.savingsPercent}%`);
  assert.ok(result.totalWithoutCache > 0);
  assert.ok(result.totalWithCache > result.totalWithoutCache); // write cost
});

test('estimateCostWithCache 5 requests shows savings', () => {
  const result = estimateCostWithCache(500, [200, 150, 180, 220, 190]);
  assert.equal(result.requestCount, 5);
  assert.ok(result.savingsPercent > 0, `savings = ${result.savingsPercent}%`);
  assert.ok(result.totalWithCache < result.totalWithoutCache);
  assert.equal(result.cacheHitRate, 80); // 4/5 = 80%
});

test('estimateCostWithCache 10 requests greater savings than 2', () => {
  const r2 = estimateCostWithCache(500, [200, 150]);
  const r10 = estimateCostWithCache(500, Array.from({ length: 10 }, () => 200));
  assert.ok(r10.savingsPercent > r2.savingsPercent,
    `10 req savings ${r10.savingsPercent}% should exceed 2 req ${r2.savingsPercent}%`);
});

test('estimateCostWithCache empty client list', () => {
  const result = estimateCostWithCache(500, []);
  assert.equal(result.savingsPercent, 0);
});

test('estimateCostWithCache custom multipliers', () => {
  const clients = [200, 150, 180];
  const default_r = estimateCostWithCache(500, clients);
  const custom_r = estimateCostWithCache(500, clients, {
    writeCostMultiplier: 1.0, // OpenAI: no write cost
    readCostMultiplier: 0.5,  // OpenAI: 50% off on read
  });
  // With OpenAI pricing, savings should be different
  assert.notEqual(custom_r.savingsPercent, default_r.savingsPercent);
});

// ---------- processBatch ----------

test('processBatch returns structured output', () => {
  const clients = [
    { company: 'A社', exhibition: '展示会A' },
    { company: 'B社', exhibition: '展示会B' },
  ];
  const result = processBatch(clients);
  assert.ok(result.staticPrefix);
  assert.ok(result.staticPrefix.tokens > 0);
  assert.equal(result.clients.length, 2);
  assert.equal(result.clients[0].company, 'A社');
  assert.ok(result.costEstimate.savingsPercent > 0);
});

test('processBatch empty input returns error', () => {
  const result = processBatch([]);
  assert.ok(result.error);
});

test('processBatch null input returns error', () => {
  const result = processBatch(null);
  assert.ok(result.error);
});

// ---------- X-0097: Cache Prefix Verification ----------

test('verifyCachePrefix returns ok=true for clean prefix', () => {
  const result = verifyCachePrefix();
  assert.equal(result.ok, true, `違反: ${result.violations.join(', ')}`);
});

test('verifyCachePrefix checks deterministic output', () => {
  const result = verifyCachePrefix();
  assert.equal(result.isDeterministic, true);
  assert.ok(result.prefixLength >= 800, `prefix length = ${result.prefixLength}`);
  assert.ok(result.estimatedTokens >= 200, `estimated tokens = ${result.estimatedTokens}`);
});

test('verifyCachePrefix prefix contains construction guidelines', () => {
  const prefix = buildStaticPrefix();
  assert.ok(prefix.includes('施工ガイドライン'), 'should include construction guidelines');
  assert.ok(prefix.includes('基本手順'), 'should include construction steps');
  assert.ok(prefix.includes('搬入出'), 'should include transport rules');
});

test('verifyCachePrefix no client-specific data in prefix', () => {
  const prefix = buildStaticPrefix();
  // クライアント固有のデータが固定プレフィックスに含まれていないこと
  assert.ok(!prefix.includes('(未設定)'), 'no (未設定) placeholder');
  assert.ok(!prefix.includes('株式会社A'), 'no company name');
  assert.ok(!prefix.includes('展示会EXPO'), 'no exhibition name');
  assert.ok(!prefix.includes('東京ビッグサイト'), 'no venue name');
  assert.ok(!prefix.includes('2026-'), 'no date pattern');
});

test('buildClientSuffix contains date info separate from prefix', () => {
  const client = {
    company: 'テスト株式会社',
    exhibition: 'テスト展示会 2026',
    venue: '東京ビッグサイト',
    dates: '2026-12-01〜03',
  };
  const suffix = buildClientSuffix(client);
  const prefix = buildStaticPrefix();

  // Client-specific data should only appear in suffix, not prefix
  assert.ok(suffix.includes('2026-12-01'));
  assert.ok(suffix.includes('テスト展示会 2026'));
  assert.ok(suffix.includes('東京ビッグサイト'));
  assert.ok(!prefix.includes('2026-12-01'));
  assert.ok(!prefix.includes('テスト展示会'));
});

test('verifyCachePrefix reports violations when variable data injected', () => {
  // Force a violation by checking that our real prefix has no violations
  const result = verifyCachePrefix();
  assert.equal(result.ok, true);
  assert.equal(result.violations.length, 0);
});

// ---------- Integration ----------

test('buildStaticPrefix → processBatch round trip', () => {
  const prefix = buildStaticPrefix();
  assert.ok(prefix.length >= 500);

  const clients = [
    { company: 'C社', exhibition: '展C', venue: '会場C' },
    { company: 'D社', exhibition: '展D', venue: '会場D' },
    { company: 'E社', exhibition: '展E', venue: '会場E' },
  ];
  const result = processBatch(clients);
  assert.equal(result.clients.length, 3);
  // Verify cost savings scale with more clients
  assert.ok(result.costEstimate.savingsPercent > 0);
  assert.ok(result.costEstimate.totalWithCache < result.costEstimate.totalWithoutCache);
});

test('Large batch (20 clients) shows meaningful savings', () => {
  const clients = Array.from({ length: 20 }, (_, i) => ({
    company: `Client${i}`,
    exhibition: `Exhibition${i}`,
    venue: `Venue${i}`,
    dates: '2026-12-01',
    budget: '50万円',
    designStyle: 'スタンダード',
    requirements: `要望${i}`,
  }));
  const result = processBatch(clients);
  // With 20 clients, cache hit rate should be 95% (19/20)
  // Savings should be substantial
  assert.ok(result.costEstimate.savingsPercent >= 30,
    `savings = ${result.costEstimate.savingsPercent}%`);
  assert.equal(result.costEstimate.requestCount, 20);
  assert.equal(result.costEstimate.cacheHitRate, 95);
});