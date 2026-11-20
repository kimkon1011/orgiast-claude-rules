// Tests for semantic-cache.mjs
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeEntropy,
  classifyEntropy,
  createEmbedding,
  cosineSimilarity,
  semanticCacheLookup,
  semanticCacheStore,
  costKillSwitch,
  semanticRoute,
} from './semantic-cache.mjs';

describe('specification boundaries', () => {
  it('counts Unicode characters and ignores whitespace in lexical entropy', () => {
    assert.equal(analyzeEntropy('😀😀').lexical, 0);
    assert.equal(analyzeEntropy('a b\t a b').lexical, analyzeEntropy('abab').lexical);
    assert.equal(analyzeEntropy('ab'.repeat(50000)).lexical, 0.5);
  });

  it('caps each structural contribution after division', () => {
    assert.equal(analyzeEntropy('\n'.repeat(10)).structural, 0.1);
    assert.equal(analyzeEntropy('\n'.repeat(100)).structural, 0.3);
    assert.equal(analyzeEntropy('-'.repeat(5)).structural, 0.1);
    assert.equal(analyzeEntropy('*'.repeat(50)).structural, 0.3);
    assert.equal(analyzeEntropy('を'.repeat(20)).structural, 0.05);
    assert.equal(analyzeEntropy('して ください。 を お願い 依頼 指示 命令 条件').structural, 0.4);
  });

  it('recognizes numbered and Japanese bullet markers', () => {
    for (const marker of ['1.', '2.', '12.', '①', '⑳', '・', '•']) {
      assert.equal(analyzeEntropy(marker).structural, 0.02, marker);
    }
  });

  it('classifies exactly at the specified thresholds', () => {
    assert.equal(classifyEntropy({ combined: 0.29999 }), 'simple');
    assert.equal(classifyEntropy({ combined: 0.3 }), 'medium');
    assert.equal(classifyEntropy({ combined: 0.6 }), 'complex');
  });

  it('limits embedding work to the first 256 characters', () => {
    const prefix = 'a'.repeat(256);
    assert.deepEqual(createEmbedding(prefix + 'x'), createEmbedding(prefix + 'y'));
    assert.deepEqual(createEmbedding(''), new Float64Array(64));
  });

  it('handles zero vectors, opposite vectors and mismatched dimensions', () => {
    assert.equal(cosineSimilarity(new Float64Array(64), createEmbedding('a')), 0);
    assert.equal(cosineSimilarity([1, 0], [-1, 0]), -1);
    assert.throws(() => cosineSimilarity([1], [1, 2]), /length mismatch/i);
  });

  it('cannot hit an empty or expired cache even with a zero threshold', () => {
    const options = { now: 100, similarityThreshold: 0 };
    assert.equal(semanticCacheLookup('q', { entries: [] }, options).hit, false);
    const cache = { entries: [{ query: 'q', response: 'r', embedding: createEmbedding('q'), timestamp: 0, ttlMs: 100 }] };
    assert.equal(semanticCacheLookup('q', cache, options).hit, false);
  });

  it('returns the most similar live entry and expires at the exact TTL boundary', () => {
    const query = '今月の売上を教えて';
    const make = (q, response, ttlMs = 100) => ({ query: q, response, embedding: createEmbedding(q), timestamp: 0, ttlMs });
    const cache = { entries: [make('今月の売上高は？', 'similar'), make(query, 'exact'), make(query, 'expired', 10)] };
    const result = semanticCacheLookup(query, cache, { now: 99 });
    assert.equal(result.response, 'exact');
    assert.equal(result.entry, cache.entries[1]);
    assert.equal(semanticCacheLookup(query, cache, { now: 100 }).hit, false);
  });

  it('applies the capacity limit even when overwriting an existing entry', () => {
    const cache = { entries: [] };
    for (const [query, now] of [['a', 30], ['b', 10], ['c', 20]]) {
      semanticCacheStore(query, query, undefined, cache, { now });
    }
    assert.equal(semanticCacheStore('a', 'new', undefined, cache, { now: 40, maxEntries: 2 }), cache);
    assert.deepEqual(cache.entries.map(entry => entry.query).sort(), ['a', 'c']);
    assert.equal(cache.entries.find(entry => entry.query === 'a').timestamp, 40);
    semanticCacheStore('a', 'newer', undefined, cache, { maxEntries: 0 });
    assert.equal(cache.entries.length, 0);
  });

  it('uses the supplied embedding for similarity-based replacement', () => {
    const cache = { entries: [] };
    const embedding = createEmbedding('common');
    semanticCacheStore('first', 'old', embedding, cache, { now: 0 });
    semanticCacheStore('second', 'new', embedding, cache, { now: 10, ttlMs: 20 });
    assert.equal(cache.entries.length, 1);
    assert.equal(cache.entries[0].query, 'second');
    assert.equal(cache.entries[0].ttlMs, 20);
  });

  it('honors a zero degrade threshold and keeps the simple route at its floor', () => {
    const result = semanticRoute('hello', {
      costState: { dailyCalls: 0, dailyCostUsd: 0, monthlyCostUsd: 0 },
      costLimits: { maxMonthlyCostUsd: 100, autoDegrade: true, degradeThreshold: 0 },
    });
    assert.equal(result.route, 'simple');
    assert.equal(result.killSwitchAction, 'degrade_to_cheaper');
    assert.equal(result.killSwitched, false);
  });

  it('rejects prohibited model overrides on every route', () => {
    for (const key of ['simpleModel', 'mediumModel', 'complexModel']) {
      for (const model of ['anthropic/claude-test', 'claude-test', 'ANTHROPIC/custom']) {
        assert.throws(() => semanticRoute('hello', { [key]: model }), /model/i);
      }
      assert.throws(() => semanticRoute('hello', { [key]: 123 }), /model/i);
    }
  });

  it('estimates each route using the specification input prices', () => {
    const medium = '以下のコードをレビューして問題点を指摘してください。';
    const complex = Array.from({ length: 50 }, (_, i) => `- 条件${i}を確認してください。`).join('\n');
    assert.equal(semanticRoute(medium).route, 'medium');
    assert.equal(semanticRoute(medium).estimatedCostUsd, 0.0005);
    assert.equal(semanticRoute(complex).route, 'complex');
    assert.equal(semanticRoute(complex).estimatedCostUsd, 0.0025);
  });
});

// ---------------------------------------------------------------------------
// 1. analyzeEntropy: 空文字と短いテキスト
// ---------------------------------------------------------------------------
describe('analyzeEntropy', () => {
  it('empty string → lexical=0, structural=0, combined=0', () => {
    const r = analyzeEntropy('');
    assert.equal(r.lexical, 0);
    assert.equal(r.structural, 0);
    assert.equal(r.combined, 0);
  });

  it("single char 'a' → lexical=0 (1 文字のエントロピーは 0)", () => {
    const r = analyzeEntropy('a');
    assert.equal(r.lexical, 0);
  });

  it('単一の日本語1文字 → lexical=0', () => {
    const r = analyzeEntropy('あ');
    assert.equal(r.lexical, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. analyzeEntropy: 複雑なテキスト
// ---------------------------------------------------------------------------
describe('analyzeEntropy — complex text', () => {
  it('長い指示文（複数行・箇条書き含む）→ combined >= 0.3', () => {
    const text = [
      '以下の手順で作業を実施してください。',
      '条件:',
      '• 対象ファイルをすべて洗い出す',
      '• 重複を削除する',
      '• 結果を報告する',
      '注意事項:',
      '・変更前のバックアップを取ること',
      '・テストを通ること',
      '・レビューを受けること',
      '以上、厳守でお願いします。',
    ].join('\n');
    const r = analyzeEntropy(text);
    assert.ok(r.combined >= 0.3, `combined=${r.combined} expected >= 0.3`);
  });

  it('非常に長いテキスト（構造含む）→ combined >= 0.6', () => {
    // Many lines, many bullet types, many instruction words
    const lines = [];
    for (let i = 0; i < 40; i++) {
      lines.push(`- 手順${i}: 必ず確認して実施してください。必ず確認して実施してください。`);
    }
    for (let i = 0; i < 20; i++) {
      lines.push(`* 条件${i}: 要求仕様を満たすこと。絶対条件として厳守。`);
    }
    for (let i = 0; i < 15; i++) {
      lines.push(`① 注意${i}: 指示に従い、ルールを守ってください。`);
    }
    const text = lines.join('\n');
    const r = analyzeEntropy(text);
    assert.ok(r.combined >= 0.6, `combined=${r.combined} expected >= 0.6`);
  });

  it('maxLength 超過時は 0 を返す', () => {
    const text = 'x'.repeat(100001);
    const r = analyzeEntropy(text);
    assert.equal(r.lexical, 0);
    assert.equal(r.structural, 0);
    assert.equal(r.combined, 0);
  });
});

// ---------------------------------------------------------------------------
// 3. analyzeEntropy: 分類基準
// ---------------------------------------------------------------------------
describe('classifyEntropy', () => {
  it('短い単語 → simple', () => {
    const r = analyzeEntropy('hello');
    assert.equal(classifyEntropy(r), 'simple');
  });

  it('中程度のテキスト → medium', () => {
    const text = [
      '以下のコードをレビューして問題点を指摘してください。',
      'ただしパフォーマンスに関する指摘は省略します。',
      'セキュリティ面に注意して確認をお願いします。',
    ].join('\n');
    const r = analyzeEntropy(text);
    assert.ok(r.combined >= 0.3, `combined=${r.combined} should be >= 0.3 for medium`);
    assert.ok(r.combined < 0.6, `combined=${r.combined} should be < 0.6 for medium`);
    assert.equal(classifyEntropy(r), 'medium');
  });

  it('複雑なテキスト → complex', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `- 項目${i}: 注意して実施し、条件を満たすこと。厳守。`);
    const text = lines.join('\n');
    const r = analyzeEntropy(text);
    assert.ok(r.combined >= 0.6, `combined=${r.combined} should be >= 0.6 for complex`);
    assert.equal(classifyEntropy(r), 'complex');
  });
});

// ---------------------------------------------------------------------------
// 4. createEmbedding: 決定論的・長さ・類似性
// ---------------------------------------------------------------------------
describe('createEmbedding', () => {
  it('同じテキストから同じベクトル', () => {
    const a = createEmbedding('テスト文章です');
    const b = createEmbedding('テスト文章です');
    assert.deepEqual(a, b);
  });

  it('長さ64のFloat64Array', () => {
    const vec = createEmbedding('hello');
    assert.equal(vec.length, 64);
    assert.ok(vec instanceof Float64Array);
  });

  it('異なるテキストから異なるベクトル', () => {
    const a = createEmbedding('全く異なるテキスト');
    const b = createEmbedding('別のテキストです');
    let same = true;
    for (let i = 0; i < 64; i++) { if (a[i] !== b[i]) { same = false; break; } }
    assert.ok(!same, 'different texts should produce different vectors');
  });

  it('類似テキスト同士のコサイン類似度 > 無関係テキスト同士', () => {
    const similar1 = createEmbedding('今月の売上を教えて');
    const similar2 = createEmbedding('今月の売上高は？');
    const unrelated = createEmbedding('天気はどうですか');

    // Compute cosine similarity manually (we can't import cosineSimilarity directly)
    function cos(a, b) {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < 64; i++) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
      }
      return dot / (Math.sqrt(na) * Math.sqrt(nb));
    }

    const simSim = cos(similar1, similar2);
    const simUnrel = cos(similar1, unrelated);
    assert.ok(simSim > simUnrel,
      `similar pair similarity (${simSim}) should exceed unrelated (${simUnrel})`);
  });
});

// ---------------------------------------------------------------------------
// 5. semanticCacheLookup: ヒットとミス
// ---------------------------------------------------------------------------
describe('semanticCacheLookup', () => {
  const baseTime = 1_000_000_000_000;
  function makeEntry(query, response, timestamp = baseTime, ttlMs = 3600000) {
    return { query, response, embedding: createEmbedding(query), timestamp, ttlMs };
  }

  it('空キャッシュ → hit=false', () => {
    const result = semanticCacheLookup('hello', { entries: [] }, { now: baseTime });
    assert.equal(result.hit, false);
  });

  it('登録済みクエリと類似 → hit=true, similarity >= 0.9', () => {
    const cache = { entries: [makeEntry('今月の売上を教えて', '売上は100万円です')] };
    const result = semanticCacheLookup('今月の売上高は？', cache, { now: baseTime });
    assert.equal(result.hit, true);
    assert.ok(result.similarity >= 0.9, `similarity=${result.similarity} expected >= 0.9`);
    assert.equal(result.response, '売上は100万円です');
  });

  it('無関係クエリ → hit=false', () => {
    const cache = { entries: [makeEntry('今月の売上を教えて', '売上は100万円です')] };
    const result = semanticCacheLookup('全く関係ない質問です', cache, { now: baseTime });
    assert.equal(result.hit, false);
  });

  it('TTL切れ → hit=false', () => {
    const cache = { entries: [makeEntry('hello', 'world', baseTime, 1000)] };
    const result = semanticCacheLookup('hello', cache, { now: baseTime + 2000 });
    assert.equal(result.hit, false);
  });

  it('カスタム類似度閾値', () => {
    const cache = { entries: [makeEntry('今月の売上を教えて', '売上は100万円です')] };
    // With a very high threshold (0.99), similar but not identical text should miss
    const result = semanticCacheLookup('今月の売上高は？', cache, {
      now: baseTime,
      similarityThreshold: 0.99,
    });
    assert.equal(result.hit, false);
  });
});

// ---------------------------------------------------------------------------
// 6. semanticCacheStore: 保存と超過削除
// ---------------------------------------------------------------------------
describe('semanticCacheStore', () => {
  const baseTime = 1_000_000_000_000;
  const emb = createEmbedding('test');

  it('新規保存 → エントリ数が増える', () => {
    const cache = { entries: [] };
    semanticCacheStore('hello', 'world', emb, cache, { now: baseTime });
    assert.equal(cache.entries.length, 1);
    assert.equal(cache.entries[0].query, 'hello');
    assert.equal(cache.entries[0].response, 'world');
  });

  it('embedding 未指定時は自動生成', () => {
    const cache = { entries: [] };
    semanticCacheStore('auto-embed', 'response', undefined, cache, { now: baseTime });
    assert.equal(cache.entries.length, 1);
    assert.ok(cache.entries[0].embedding instanceof Float64Array);
    assert.equal(cache.entries[0].embedding.length, 64);
  });

  it('maxEntries超過 → 古いエントリが削除される', () => {
    const cache = { entries: [] };
    const options = { now: baseTime, maxEntries: 3, ttlMs: 3600000 };
    semanticCacheStore('q1', 'r1', createEmbedding('q1'), cache, { ...options, now: baseTime });
    semanticCacheStore('q2', 'r2', createEmbedding('q2'), cache, { ...options, now: baseTime + 100 });
    semanticCacheStore('q3', 'r3', createEmbedding('q3'), cache, { ...options, now: baseTime + 200 });
    assert.equal(cache.entries.length, 3);
    semanticCacheStore('q4', 'r4', createEmbedding('q4'), cache, { ...options, now: baseTime + 300 });
    assert.equal(cache.entries.length, 3);
    // The oldest (q1 with timestamp baseTime) should be evicted
    const queries = cache.entries.map(e => e.query);
    assert.ok(!queries.includes('q1'), 'q1 should be evicted');
    assert.ok(queries.includes('q4'), 'q4 should be in cache');
  });

  it('同一クエリ上書き → エントリ数が増えない', () => {
    const cache = { entries: [] };
    const q = '同じクエリ';
    const e = createEmbedding(q);
    semanticCacheStore(q, 'first', e, cache, { now: baseTime });
    assert.equal(cache.entries.length, 1);
    semanticCacheStore(q, 'second', e, cache, { now: baseTime + 100 });
    assert.equal(cache.entries.length, 1, 'same query should overwrite, not add');
    assert.equal(cache.entries[0].response, 'second', 'should hold the latest response');
  });

  it('類似度 0.99 以上のクエリは上書き（同一扱い）', () => {
    const cache = { entries: [] };
    // Use identical text to guarantee 0.99+ similarity
    const e1 = createEmbedding('identical text');
    semanticCacheStore('identical text', 'original', e1, cache, { now: baseTime });
    assert.equal(cache.entries.length, 1);
    const e2 = createEmbedding('identical text');
    semanticCacheStore('identical text', 'updated', e2, cache, { now: baseTime + 100 });
    assert.equal(cache.entries.length, 1, '>= 0.99 similarity should overwrite');
    assert.equal(cache.entries[0].response, 'updated');
  });
});

// ---------------------------------------------------------------------------
// 7. costKillSwitch: 各種制限
// ---------------------------------------------------------------------------
describe('costKillSwitch', () => {
  const limits = {
    maxDailyCalls: 100,
    maxDailyCostUsd: 50,
    maxMonthlyCostUsd: 1000,
  };

  it('制限なし → allowed=true', () => {
    const state = { dailyCalls: 0, dailyCostUsd: 0, monthlyCostUsd: 0 };
    const result = costKillSwitch(state, limits);
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'ok');
  });

  it('dailyCalls超過 → allowed=false', () => {
    const state = { dailyCalls: 100, dailyCostUsd: 0, monthlyCostUsd: 0 };
    const result = costKillSwitch(state, limits);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'daily_calls_exceeded');
    assert.equal(result.suggestedAction, 'stop');
  });

  it('dailyCost超過 → allowed=false', () => {
    const state = { dailyCalls: 0, dailyCostUsd: 50, monthlyCostUsd: 0 };
    const result = costKillSwitch(state, limits);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'daily_cost_exceeded');
  });

  it('dailyCost超過 + autoDegrade → degrade_to_cheaper', () => {
    const state = { dailyCalls: 0, dailyCostUsd: 50, monthlyCostUsd: 0 };
    const result = costKillSwitch(state, { ...limits, autoDegrade: true });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'daily_cost_exceeded');
    assert.equal(result.suggestedAction, 'degrade_to_cheaper');
  });

  it('monthlyCost超過 → allowed=false', () => {
    const state = { dailyCalls: 0, dailyCostUsd: 0, monthlyCostUsd: 1000 };
    const result = costKillSwitch(state, limits);
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'monthly_cost_exceeded');
    assert.equal(result.suggestedAction, 'wait');
  });

  it('autoDegrade + degradeThreshold → suggestedAction degrade_to_cheaper', () => {
    const state = { dailyCalls: 0, dailyCostUsd: 0, monthlyCostUsd: 800 };
    const result = costKillSwitch(state, {
      ...limits,
      autoDegrade: true,
      degradeThreshold: 0.75,
    });
    // monthlyCostUsd 800 / maxMonthlyCostUsd 1000 = 0.80 >= 0.75
    assert.equal(result.allowed, true);
    assert.equal(result.reason, 'ok');
    assert.equal(result.suggestedAction, 'degrade_to_cheaper');
  });

  it('閾値未満なら degrade されない', () => {
    const state = { dailyCalls: 0, dailyCostUsd: 0, monthlyCostUsd: 100 };
    const result = costKillSwitch(state, {
      ...limits,
      autoDegrade: true,
      degradeThreshold: 0.75,
    });
    assert.equal(result.allowed, true);
    assert.equal(result.suggestedAction, undefined);
  });
});

// ---------------------------------------------------------------------------
// 8. semanticRoute: 統合パス
// ---------------------------------------------------------------------------
describe('semanticRoute', () => {
  const baseTime = 1_000_000_000_000;
  const makeCache = (query, response) => ({
    entries: [{ query, response, embedding: createEmbedding(query), timestamp: baseTime, ttlMs: 3600000 }],
  });

  it('キャッシュヒットで cacheHit=true', () => {
    const cache = makeCache('今月の売上', '売上100万円');
    const result = semanticRoute('今月の売上高', { cache, now: baseTime });
    assert.equal(result.cacheHit, true);
    assert.equal(result.cacheResponse, '売上100万円');
  });

  it('複雑テキスト → route=complex', () => {
    const lines = Array.from({ length: 50 }, (_, i) => [
      `- 設計要件${i}: アーキテクチャを考慮し、トレードオフを分析。`,
      `条件: 創造的な解決策を提案。戦略的観点から判断。`,
    ].join('\n'));
    const text = lines.join('\n');
    const result = semanticRoute(text);
    assert.equal(result.route, 'complex');
    assert.ok(result.entropy.combined >= 0.6);
  });

  it('単純テキスト → route=simple', () => {
    const result = semanticRoute('hello');
    assert.equal(result.route, 'simple');
  });

  it('キルスイッチ発動で killSwitched=true', () => {
    const costState = { dailyCalls: 200, dailyCostUsd: 0, monthlyCostUsd: 0 };
    const costLimits = { maxDailyCalls: 100, maxDailyCostUsd: 50, maxMonthlyCostUsd: 1000 };
    const result = semanticRoute('hello', { costState, costLimits });
    assert.equal(result.killSwitched, true);
  });

  it('キルスイッチ縮退時はモデルが一段階安くなる (complex→medium)', () => {
    const costState = { dailyCalls: 0, dailyCostUsd: 0, monthlyCostUsd: 900 };
    const costLimits = {
      maxDailyCalls: 100, maxDailyCostUsd: 50, maxMonthlyCostUsd: 1000,
      autoDegrade: true, degradeThreshold: 0.8,
    };
    // Use complex text so it would normally route to complex
    const lines = Array.from({ length: 50 }, (_, i) => `- 設計要件${i}: 戦略的判断が必要です。厳守。`);
    const text = lines.join('\n');
    const result = semanticRoute(text, { costState, costLimits });
    // 900/1000 = 0.9 >= 0.8 → degrade_to_cheaper, complex→medium
    assert.equal(result.route, 'medium', 'should degrade to medium');
    assert.equal(result.model, 'moonshotai/kimi-k3');
    assert.equal(result.killSwitched, false); // autoDegrade doesn't set killSwitched
    assert.equal(result.killSwitchAction, 'degrade_to_cheaper');
  });

  it('日次コスト超過でも autoDegrade 指定時は停止せず一段階縮退する', () => {
    const costState = { dailyCalls: 0, dailyCostUsd: 50, monthlyCostUsd: 0 };
    const costLimits = {
      maxDailyCalls: 100, maxDailyCostUsd: 50, maxMonthlyCostUsd: 1000,
      autoDegrade: true,
    };
    const lines = Array.from({ length: 50 }, (_, i) => `- 設計要件${i}: 戦略的判断が必要です。厳守。`);
    const result = semanticRoute(lines.join('\n'), { costState, costLimits });

    assert.equal(result.route, 'medium');
    assert.equal(result.model, 'moonshotai/kimi-k3');
    assert.equal(result.killSwitched, false);
    assert.equal(result.killSwitchAction, 'degrade_to_cheaper');
  });

  it('キルスイッチ縮退 (medium→simple)', () => {
    const costState = { dailyCalls: 0, dailyCostUsd: 0, monthlyCostUsd: 900 };
    const costLimits = {
      maxDailyCalls: 100, maxDailyCostUsd: 50, maxMonthlyCostUsd: 1000,
      autoDegrade: true, degradeThreshold: 0.8,
    };
    const text = [
      '以下のコードをレビューして問題点を指摘してください。',
      'ただしパフォーマンスに関する指摘は省略します。',
      'セキュリティ面に注意して確認をお願いします。',
    ].join('\n');
    const result = semanticRoute(text, { costState, costLimits });
    // medium → simple
    assert.equal(result.route, 'simple', 'should degrade to simple');
    assert.equal(result.model, 'deepseek/deepseek-v4-flash');
  });

  it('estimatedCostUsd が正しい形式で返る', () => {
    const result = semanticRoute('hello');
    assert.ok(typeof result.estimatedCostUsd === 'number');
    assert.ok(result.estimatedCostUsd > 0);
    // simple: 1000 * 0.15 / 1e6 = 0.00015
    assert.equal(result.estimatedCostUsd, 0.00015);
  });

  it('カスタムモデル指定が反映される', () => {
    const result = semanticRoute('hello', {
      simpleModel: 'groq/llama-3-8b',
    });
    assert.equal(result.model, 'groq/llama-3-8b');
  });

  it('キャッシュミス時は cacheHit=false', () => {
    const result = semanticRoute('hello', { cache: { entries: [] }, now: baseTime });
    assert.equal(result.cacheHit, false);
    assert.equal(result.cacheResponse, undefined);
  });
});
