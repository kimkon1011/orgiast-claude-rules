// Tests for praxis-gateway.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  staticPrefixMatch,
  bodyRoute,
  classifyBodyRoute,
  translateRequest,
  tokenAccounting,
  estimateCostReduction,
  ROUTING_TABLE,
  DEFAULT_PREFIXES,
} from './praxis-gateway.mjs';

// ---------------------------------------------------------------------------
// Static prefix matching
// ---------------------------------------------------------------------------
describe('staticPrefixMatch', () => {
  it('matches a known prefix string in text', () => {
    const text = '会社概要は株式会社オージャストです。設営実績は100件以上。';
    const result = staticPrefixMatch(text);
    assert.equal(result.matched, true);
    assert.equal(result.prefix.name, 'company_profile');
    assert.ok(result.cachedLength > 0);
    assert.ok(result.remaining.length < text.length);
  });

  it('returns no match for unrelated text', () => {
    const result = staticPrefixMatch('こんにちは、今日の天気は？');
    assert.equal(result.matched, false);
    assert.equal(result.prefix, null);
    assert.equal(result.remaining, 'こんにちは、今日の天気は？');
  });

  it('matches the longest prefix', () => {
    // Custom prefixes with overlapping patterns
    const prefixes = [
      { name: 'short', pattern: '会社', model: 'economy', ttlSec: 300 },
      { name: 'long', pattern: '会社概要', model: 'medium', ttlSec: 600 },
    ];
    const result = staticPrefixMatch('会社概要はオージャスト', prefixes);
    assert.equal(result.matched, true);
    assert.equal(result.prefix.name, 'long');  // longer pattern wins
    assert.equal(result.prefix.model, 'medium');
  });

  it('returns the correct remaining text after prefix', () => {
    const text = '過去事例として、2025年東京モーターショーのブースを担当しました。';
    const result = staticPrefixMatch(text);
    assert.equal(result.matched, true);
    assert.ok(result.remaining.includes('東京モーターショー'));
  });

  it('throws on non-string input', () => {
    assert.throws(() => staticPrefixMatch(123), /must be a string/);
  });
});

// ---------------------------------------------------------------------------
// Body-based routing
// ---------------------------------------------------------------------------
describe('classifyBodyRoute', () => {
  it('routes frontier keywords to frontier', () => {
    assert.equal(classifyBodyRoute('ブースの設計コンセプトを考えて'), 'frontier');
    assert.equal(classifyBodyRoute('展示会の戦略と企画方針を立案'), 'frontier');
    assert.equal(classifyBodyRoute('creative concept for booth design'), 'frontier');
  });

  it('routes economy keywords to economy', () => {
    assert.equal(classifyBodyRoute('このテキストを分類して'), 'economy');
    assert.equal(classifyBodyRoute('データを抽出してください'), 'economy');
    assert.equal(classifyBodyRoute('simple template fill'), 'economy');
  });

  it('routes batch keywords to batch', () => {
    assert.equal(classifyBodyRoute('大量のデータを一括処理'), 'batch');
    assert.equal(classifyBodyRoute('batch processing all items'), 'batch');
  });

  it('falls back to medium for ambiguous text', () => {
    assert.equal(classifyBodyRoute('ファイルを読んで明日の天気を教えて'), 'medium');
    assert.equal(classifyBodyRoute('こんにちは'), 'medium');
  });
});

describe('bodyRoute', () => {
  it('applies prefix matching when enabled', () => {
    const result = bodyRoute('会社概要はオージャスト株式会社です。事業内容は展示会ブース制作。');
    assert.equal(result.prefixMatched, true);
    assert.equal(result.prefixName, 'company_profile');
    assert.equal(result.route, 'economy');
  });

  it('falls back to classification when no prefix matches', () => {
    const result = bodyRoute('展示会の戦略と企画方針を立案してください');
    assert.equal(result.prefixMatched, false);
    assert.equal(result.route, 'frontier');
  });

  it('measures prefix saved characters', () => {
    const result = bodyRoute('安全基準に従って施工手順を作成');
    assert.equal(result.prefixMatched, true);
    assert.ok(result.prefixSaved > 0);
  });

  it('returns cost estimates', () => {
    const result = bodyRoute('テキストを分類して');
    assert.ok(result.estimatedCostUsd >= 0);
    assert.ok(result.costInputUsd >= 0);
    assert.ok(result.costOutputUsd >= 0);
    assert.ok(result.inputTokens > 0);
  });

  it('throws on non-string input', () => {
    assert.throws(() => bodyRoute(42), /must be a string/);
  });
});

// ---------------------------------------------------------------------------
// Provider translation
// ---------------------------------------------------------------------------
describe('translateRequest', () => {
  const openaiBody = {
    model: 'gpt-4o',
    messages: [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello!' },
    ],
    max_tokens: 2048,
  };

  const anthropicBody = {
    model: 'claude-sonnet-4',
    system: 'You are a helpful assistant.',
    messages: [
      { role: 'user', content: 'Hello!' },
    ],
    max_tokens: 2048,
  };

  it('translates OpenAI → Anthropic', () => {
    const result = translateRequest(openaiBody, 'openai', 'anthropic');
    assert.equal(result.system, 'You are a helpful assistant.');
    assert.equal(result.messages.length, 1);
    assert.equal(result.messages[0].role, 'user');
    assert.equal(result.messages[0].content, 'Hello!');
  });

  it('translates Anthropic → OpenAI', () => {
    const result = translateRequest(anthropicBody, 'anthropic', 'openai');
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[0].role, 'system');
    assert.equal(result.messages[1].content, 'Hello!');
  });

  it('returns identity for same provider', () => {
    const result = translateRequest(openaiBody, 'openai', 'openai');
    assert.equal(result.model, 'gpt-4o');
  });

  it('throws for unknown providers', () => {
    assert.throws(() => translateRequest(openaiBody, 'openai', 'unknown'), /Unknown target/);
  });

  it('throws for invalid body', () => {
    assert.throws(() => translateRequest('not-object', 'openai', 'anthropic'), /must be an object/);
  });
});

// ---------------------------------------------------------------------------
// Token accounting
// ---------------------------------------------------------------------------
describe('tokenAccounting', () => {
  it('aggregates by model and route', () => {
    const log = [
      { model: 'deepseek-flash', route: 'economy', inputTokens: 1000, outputTokens: 500 },
      { model: 'deepseek-flash', route: 'economy', inputTokens: 2000, outputTokens: 1000 },
      { model: 'gpt-6-luna', route: 'frontier', inputTokens: 500, outputTokens: 300 },
    ];
    const result = tokenAccounting(log);
    assert.equal(result.totals.calls, 3);
    assert.equal(result.totals.inputTokens, 3500);
    assert.equal(result.rows.length, 2);
    assert.ok(result.table.includes('deepseek-flash'));
    assert.ok(result.table.includes('gpt-6-luna'));
  });

  it('handles empty log', () => {
    const result = tokenAccounting([]);
    assert.equal(result.totals.calls, 0);
    assert.equal(result.rows.length, 0);
  });

  it('throws for non-array', () => {
    assert.throws(() => tokenAccounting('not-array'), /must be an array/);
  });

  it('throws for missing token fields', () => {
    assert.throws(() => tokenAccounting([{ model: 'test' }]), /numeric/);
  });
});

// ---------------------------------------------------------------------------
// Cost reduction estimation
// ---------------------------------------------------------------------------
describe('estimateCostReduction', () => {
  const traffic = { prompts: 1000, avgInputTk: 2000, avgOutputTk: 4000 };

  it('computes baseline vs optimized cost', () => {
    const result = estimateCostReduction(traffic, {
      baselineRoute: 'frontier',
      cacheableRatio: 0.6,
      rerouteFraction: 0.5,
      avgPrefixRatio: 0.4,
    });
    assert.ok(result.baselineMonthlyUsd > 0);
    assert.ok(result.optimizedMonthlyUsd > 0);
    assert.ok(result.savingsUsd > 0);
    assert.ok(result.reductionPercent > 0);
    assert.ok(result.reductionPercent < 100);
  });

  it('returns higher savings with higher cacheable ratio', () => {
    const lowCache = estimateCostReduction(traffic, { cacheableRatio: 0.3 });
    const highCache = estimateCostReduction(traffic, { cacheableRatio: 0.9 });
    assert.ok(highCache.reductionPercent > lowCache.reductionPercent);
  });

  it('returns breakpoint analysis', () => {
    const result = estimateCostReduction(traffic);
    assert.ok(result.breakpoints['cacheable_30pct']);
    assert.ok(result.breakpoints['cacheable_50pct']);
    assert.ok(result.breakpoints['cacheable_70pct']);
    assert.ok(result.breakpoints['cacheable_90pct']);
  });

  it('returns zero savings with no traffic', () => {
    assert.throws(() => estimateCostReduction({ prompts: 0, avgInputTk: 2000, avgOutputTk: 4000 }), /positive/);
  });

  it('throws for invalid ratio values', () => {
    assert.throws(() => estimateCostReduction(traffic, { cacheableRatio: -0.1 }), /must be in/);
    assert.throws(() => estimateCostReduction(traffic, { cacheableRatio: 1.5 }), /must be in/);
  });
});