import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost } from './x0040-prompt-cache-cost.mjs';

describe('x0040-prompt-cache-cost', () => {
  // ── 既定条件 ──────────────────────────────────────
  // Fable 5.2, 80K総入力（全トークンキャッシュ対象）, 出力0 Tok, 50ターン, 4分間隔
  // 初回: 80K × $10.00/1M = $0.800
  // 2〜50回目: 49 × 80K × $0.20/1M = 49 × $0.016 = $0.784
  // 合計: $1.584 → 四捨五入 $1.58
  it('既定条件が厳密に $1.58 になる', () => {
    const r = calculateCost();
    assert.equal(r.model, 'fable-5-2');
    assert.equal(r.turns, 50);
    assert.equal(r.totalTokens, 80000);
    assert.equal(r.outputTokens, 0);
    assert.equal(r.cacheExpired, false);
    assert.equal(r.roundedTotal, 1.58);
    // 内訳検証: 初回 $0.800
    assert.equal(r.breakdown[0].subtotal, 0.8);
    // 内訳検証: 2回目 $0.016
    assert.equal(r.breakdown[1].subtotal, 0.016);
    // 合計（未丸め）$1.584
    assert.equal(r.cachedTotal, 1.584);
    // 削減率 95.05%
    assert.equal(r.savingsRate, 0.9505);
  });

  // ── キャッシュ期限切れ ────────────────────────────
  it('間隔が5分超なら毎ターン再書込になりキャッシュなしより高い', () => {
    const r = calculateCost({ intervalMs: 300001 });
    assert.equal(r.cacheExpired, true);
    // 全50ターンがキャッシュ書込（1.25x）: 50 × $0.80 = $40.00
    // キャッシュなし（$32.00）より高い — 書込サーチャージが毎回かかるため
    assert.equal(r.cachedTotal, 40.0);
    assert.ok(r.cachedTotal > r.uncachedTotal);
  });

  // ── プレフィックス変更 ────────────────────────────
  it('prefixChanges=[25]でturn 25だけ再書込、総額$2.37', () => {
    // 既定条件（80K全キャッシュ、50ターン、4分間隔）でturn 25にprefix変更
    // turn 1:  cache_write $0.800
    // turns 2-24:  23×cache_read $0.016 = $0.368
    // turn 25:     cache_write_prefix_changed $0.800
    // turns 26-50: 25×cache_read $0.016 = $0.400
    // 合計: $2.368 → rounded $2.37
    const r = calculateCost({ prefixChanges: [25] });
    assert.equal(r.roundedTotal, 2.37);
    assert.equal(r.cachedTotal, 2.368);
    // turn 25のphaseがcache_write_prefix_changed
    const turn25 = r.breakdown[24]; // 0-indexedなので24
    assert.equal(turn25.phase, 'cache_write_prefix_changed');
    assert.equal(turn25.subtotal, 0.8);
    // turn 1のphaseはcache_write（変わらず）
    assert.equal(r.breakdown[0].phase, 'cache_write');
    // turn 2のphaseはcache_read
    assert.equal(r.breakdown[1].phase, 'cache_read');
    // turn 26のphaseもcache_read（変更後も読取に戻る）
    assert.equal(r.breakdown[25].phase, 'cache_read');
  });

  // ── 不正パラメータ ────────────────────────────────
  it('cacheTokens が totalTokens を超えるとエラー', () => {
    assert.throws(
      () => calculateCost({ cacheTokens: 90000, totalTokens: 80000 }),
      /cacheTokens/
    );
  });

  it('不明なモデル名でエラー', () => {
    assert.throws(
      () => calculateCost({ model: 'unknown-model' }),
      /Unknown model/
    );
  });

  // ── エッジケース ──────────────────────────────────
  it('1ターンだけの計算', () => {
    const r = calculateCost({ turns: 1 });
    // 初回のみ: $0.80
    assert.equal(r.cachedTotal, 0.8);
    assert.equal(r.breakdown.length, 1);
  });

  it('出力トークンがあるとコストが増える', () => {
    const r0 = calculateCost({ outputTokens: 0 });
    const r1 = calculateCost({ outputTokens: 20 });
    assert.ok(r1.cachedTotal > r0.cachedTotal);
  });

  // ── キャッシュなしとの比較 ────────────────────────
  it('キャッシュなし 50ターン 80K → $32.00', () => {
    const r = calculateCost();
    assert.equal(r.uncachedTotal, 32.0);
  });

  // ── 異なるターン数 ────────────────────────────────
  it('100ターンで $2.38（$0.80 + 99×$0.016）', () => {
    // 100ターンの計算: $0.80 + 99 × $0.016 = $0.80 + $1.584 = $2.384 → $2.38
    const r = calculateCost({ turns: 100 });
    assert.equal(r.roundedTotal, 2.38);
    assert.equal(r.cachedTotal, 2.384);
  });

  // ── 非キャッシュトークンあり ──────────────────────
  it('80K中60Kキャッシュ、20K非キャッシュ', () => {
    const r = calculateCost({ totalTokens: 80000, cacheTokens: 60000 });
    // 初回: 60K×$10 + 20K×$8 = $0.60 + $0.16 = $0.76
    assert.equal(r.breakdown[0].subtotal, 0.76);
    // 2回目: 60K×$0.20 + 20K×$8 = $0.012 + $0.16 = $0.172
    assert.equal(r.breakdown[1].subtotal, 0.172);
  });
});
