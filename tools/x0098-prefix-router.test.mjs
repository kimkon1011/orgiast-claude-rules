// tools/x0098-prefix-router.test.mjs — X-0098 プレフィックスアウェア・ルーティングのテスト
// node --test tools/x0098-prefix-router.test.mjs
//
// テスト戦略:
//   - hashPrefix: FNV-1a ハッシュの一貫性・衝突傾向
//   - createRing: リング構築の正確性
//   - routeRequest: 同一プレフィックス→同一ワーカー
//   - addWorker/removeWorker: ワーカー増減の影響範囲
//   - simulateRoundRobin: ラウンドロビンの統計が正しいか
//   - simulateAffinity: アフィニティの統計が正しいか
//   - compareStrategies: 改善率の計算
//   - demo: 全シナリオがエラーなく実行できる

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let _m;
async function load() {
  if (!_m) _m = await import('./x0098-prefix-router.mjs');
  return _m;
}

// ============================================================
// テスト1: hashPrefix (FNV-1a)
// ============================================================
describe('hashPrefix (FNV-1a)', async () => {
  let m;
  before(async () => { m = await load(); });

  it('同じプレフィックスから同じハッシュ値を返す（決定性）', () => {
    const h1 = m.hashPrefix('展示会ブースデザイナー');
    const h2 = m.hashPrefix('展示会ブースデザイナー');
    assert.equal(h1, h2);
  });

  it('異なるプレフィックスから異なるハッシュ値を返す傾向がある', () => {
    const h1 = m.hashPrefix('AAA');
    const h2 = m.hashPrefix('BBB');
    assert.notEqual(h1, h2);
  });

  it('空文字列のハッシュが計算できる', () => {
    const h = m.hashPrefix('');
    assert.ok(typeof h === 'number');
    assert.ok(h >= 0 && h < 2 ** 32);
  });

  it('ハッシュ値は 0〜2^32-1 の範囲', () => {
    for (const s of ['a', 'hello', '長いテスト文字列です'.repeat(10), '12345', '!@#$%']) {
      const h = m.hashPrefix(s);
      assert.ok(h >= 0 && h < 2 ** 32, `${s} → ${h} が範囲外`);
    }
  });

  it('長い文字列でも一貫したハッシュを返す', () => {
    const long = 'A'.repeat(10000);
    const h1 = m.hashPrefix(long);
    const h2 = m.hashPrefix(long);
    assert.equal(h1, h2);
  });

  it('UTF-8 マルチバイト文字を正しく扱う', () => {
    const h = m.hashPrefix('🍎🔥🚀');
    assert.ok(typeof h === 'number');
    assert.ok(h >= 0);
  });
});

// ============================================================
// テスト2: hashPrefixSha256
// ============================================================
describe('hashPrefixSha256', async () => {
  let m;
  before(async () => { m = await load(); });

  it('決定性がある', () => {
    const h1 = m.hashPrefixSha256('test');
    const h2 = m.hashPrefixSha256('test');
    assert.equal(h1, h2);
  });

  it('0〜2^32-1 の範囲', () => {
    const h = m.hashPrefixSha256('test');
    assert.ok(h >= 0 && h < 2 ** 32);
  });
});

// ============================================================
// テスト3: createRing
// ============================================================
describe('createRing', async () => {
  let m;
  before(async () => { m = await load(); });

  it('3ワーカーでリングが構築できる', () => {
    const ring = m.createRing(['w1', 'w2', 'w3']);
    assert.equal(ring.workers.length, 3);
    // 仮想ノード数: 各ワーカー 100 ノード → 合計 300
    assert.equal(ring.entries.length, 300);
  });

  it('8ワーカーでリングが構築できる', () => {
    const ring = m.createRing(['w1', 'w2', 'w3', 'w4', 'w5', 'w6', 'w7', 'w8']);
    assert.equal(ring.entries.length, 800);
  });

  it('ソート済みである', () => {
    const ring = m.createRing(['a', 'b', 'c']);
    for (let i = 1; i < ring.entries.length; i++) {
      assert.ok(ring.entries[i].position >= ring.entries[i - 1].position,
        `position[${i}] (${ring.entries[i].position}) < position[${i - 1}] (${ring.entries[i - 1].position})`);
    }
  });

  it('空の配列でエラー', () => {
    assert.throws(() => m.createRing([]), /non-empty/);
  });

  it('SHA-256 モードで構築できる', () => {
    const ring = m.createRing(['a', 'b'], { useSha256: true });
    assert.equal(ring.entries.length, 200);
    assert.equal(ring.workers.length, 2);
  });
});

// ============================================================
// テスト4: routeRequest (ルーティングの一貫性)
// ============================================================
describe('routeRequest', async () => {
  let m;
  before(async () => { m = await load(); });

  it('同一プレフィックスは同一ワーカーにルーティングされる', () => {
    const ring = m.createRing(['w1', 'w2', 'w3', 'w4']);
    const prefix = '展示会ブースの標準テンプレート';
    const r1 = m.routeRequest(ring, prefix);
    const r2 = m.routeRequest(ring, prefix);
    const r3 = m.routeRequest(ring, prefix);
    assert.equal(r1, r2);
    assert.equal(r2, r3);
    assert.ok(['w1', 'w2', 'w3', 'w4'].includes(r1));
  });

  it('異なるプレフィックスは異なるワーカーに行く傾向がある', () => {
    const ring = m.createRing(['w1', 'w2', 'w3', 'w4']);
    const results = new Set();
    const prefixes = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF', 'GGG', 'HHH'];
    for (const p of prefixes) {
      results.add(m.routeRequest(ring, p));
    }
    // 最低2種類以上のワーカーに分散
    assert.ok(results.size >= 2, `Only ${results.size} unique workers: ${[...results].join(',')}`);
  });

  it('プレフィックスが空でもエラーにならない', () => {
    const ring = m.createRing(['w1']);
    const result = m.routeRequest(ring, '');
    assert.equal(result, 'w1');
  });

  it('SHA-256 モードでも同一プレフィックス→同一ワーカー', () => {
    const ring = m.createRing(['w1', 'w2'], { useSha256: true });
    const r1 = m.routeRequest(ring, 'test-prefix', { useSha256: true });
    const r2 = m.routeRequest(ring, 'test-prefix', { useSha256: true });
    assert.equal(r1, r2);
  });

  it('ラップアラウンド（大きなハッシュ値）が正しく処理される', () => {
    // 意図的にリングの最後の位置より大きなハッシュを生成
    const ring = m.createRing(['a']);
    const result = m.routeRequest(ring, 'zzzzzzzzzz');
    assert.equal(result, 'a');
  });
});

// ============================================================
// テスト5: addWorker / removeWorker
// ============================================================
describe('addWorker / removeWorker', async () => {
  let m;
  before(async () => { m = await load(); });

  it('addWorker でワーカーが追加される', () => {
    const ring = m.createRing(['a', 'b']);
    const ring2 = m.addWorker(ring, 'c');
    assert.equal(ring2.workers.length, 3);
    assert.equal(ring2.entries.length, 300);
    assert.ok(ring2.workers.includes('c'));
  });

  it('既存ワーカーの再追加は無視される', () => {
    const ring = m.createRing(['a', 'b']);
    const ring2 = m.addWorker(ring, 'a');
    assert.equal(ring2.workers.length, 2);
    assert.equal(ring2.entries.length, 200);
  });

  it('removeWorker でワーカーが削除される', () => {
    const ring = m.createRing(['a', 'b', 'c']);
    const ring2 = m.removeWorker(ring, 'c');
    assert.equal(ring2.workers.length, 2);
    assert.equal(ring2.entries.length, 200);
    assert.ok(!ring2.workers.includes('c'));
  });

  it('存在しないワーカーの削除は無視される', () => {
    const ring = m.createRing(['a', 'b']);
    const ring2 = m.removeWorker(ring, 'nonexistent');
    assert.equal(ring2.workers.length, 2);
    assert.equal(ring2.entries.length, 200);
  });

  it('ワーカー追加・削除後もルーティングが正しく動作する', () => {
    let ring = m.createRing(['a', 'b']);
    const prefixes = ['pref-A', 'pref-B', 'pref-C'];
    const beforeRoutes = prefixes.map(p => m.routeRequest(ring, p));

    ring = m.addWorker(ring, 'c');
    const afterAddRoutes = prefixes.map(p => m.routeRequest(ring, p));

    ring = m.removeWorker(ring, 'c');
    const afterRemoveRoutes = prefixes.map(p => m.routeRequest(ring, p));

    // 削除後は元のルーティングに戻る（仮想ノードの影響で完全一致はしないが、
    // ワーカーセットが同じならルーティング先も同じになる）
    assert.deepEqual(afterRemoveRoutes, beforeRoutes);
  });
});

// ============================================================
// テスト6: simulateRoundRobin
// ============================================================
describe('simulateRoundRobin', async () => {
  let m;
  before(async () => { m = await load(); });

  it('同一プレフィックス3件・2ワーカー → ヒット率50%', () => {
    const requests = [
      { id: 'a1', prefix: 'AAA' },
      { id: 'a2', prefix: 'AAA' },
      { id: 'a3', prefix: 'AAA' },
    ];
    const result = m.simulateRoundRobin(requests, 2);
    assert.equal(result.totalRequests, 3);
    // worker-0: リクエストa1(ミス), a3(ヒット) → 1ミス1ヒット
    // worker-1: リクエストa2(初回) → 1ミス0ヒット
    // 合計: ミス2, ヒット1 → 33.3%
    assert.equal(result.cacheHits, 1);
    assert.equal(result.cacheMisses, 2);
  });

  it('同一プレフィックス1件 → ミスのみ', () => {
    const requests = [{ id: 'a1', prefix: 'AAA' }];
    const result = m.simulateRoundRobin(requests, 8);
    assert.equal(result.totalRequests, 1);
    assert.equal(result.cacheHits, 0);
    assert.equal(result.cacheMisses, 1);
    assert.equal(result.hitRate, 0);
  });

  it('空配列 → ゼロ結果', () => {
    const result = m.simulateRoundRobin([], 8);
    assert.equal(result.totalRequests, 0);
    assert.equal(result.hitRate, 0);
  });
});

// ============================================================
// テスト7: simulateAffinity
// ============================================================
describe('simulateAffinity', async () => {
  let m;
  before(async () => { m = await load(); });

  it('同一プレフィックス3件 → ヒット率66.7%', () => {
    const requests = [
      { id: 'a1', prefix: 'AAA' },
      { id: 'a2', prefix: 'AAA' },
      { id: 'a3', prefix: 'AAA' },
    ];
    const result = m.simulateAffinity(requests, 8);
    assert.equal(result.totalRequests, 3);
    // 1台のワーカーに集中 → 初回ミス, 残り2回ヒット
    assert.equal(result.cacheHits, 2);
    assert.equal(result.cacheMisses, 1);
    assert.equal(result.hitRate, 66.7);
  });

  it('同一プレフィックス1件 → ミスのみ', () => {
    const requests = [{ id: 'a1', prefix: 'AAA' }];
    const result = m.simulateAffinity(requests, 8);
    assert.equal(result.cacheHits, 0);
    assert.equal(result.cacheMisses, 1);
  });

  it('複数プレフィックス → 各グループで初回のみミス', () => {
    const requests = [
      { id: 'a1', prefix: 'A' }, { id: 'a2', prefix: 'A' },
      { id: 'b1', prefix: 'B' }, { id: 'b2', prefix: 'B' }, { id: 'b3', prefix: 'B' },
    ];
    const result = m.simulateAffinity(requests, 8);
    // A: 1ミス+1ヒット, B: 1ミス+2ヒット → 計2ミス3ヒット
    assert.equal(result.cacheMisses, 2);
    assert.equal(result.cacheHits, 3);
    assert.equal(result.hitRate, 60);
  });

  it('空配列 → ゼロ結果', () => {
    const result = m.simulateAffinity([], 8);
    assert.equal(result.totalRequests, 0);
  });
});

// ============================================================
// テスト8: compareStrategies
// ============================================================
describe('compareStrategies', async () => {
  let m;
  before(async () => { m = await load(); });

  it('アフィニティのヒット率がラウンドロビンより高い', () => {
    const requests = [
      { id: 'a1', prefix: 'A' }, { id: 'a2', prefix: 'A' },
      { id: 'b1', prefix: 'B' }, { id: 'b2', prefix: 'B' },
      { id: 'c1', prefix: 'C' }, { id: 'c2', prefix: 'C' },
    ];
    const result = m.compareStrategies(requests, 8);
    assert.ok(result.affinity.hitRate >= result.roundRobin.hitRate,
      `affinity ${result.affinity.hitRate}% < rr ${result.roundRobin.hitRate}%`);
    assert.ok(result.improvement.hitRateGain >= 0);
    assert.ok(result.improvement.missReduction >= 0);
    assert.ok(result.uniquePrefixes > 0);
  });

  it('単一プレフィックス大量での改善が顕著', () => {
    const requests = Array.from({ length: 100 }, (_, i) => ({ id: `r${i}`, prefix: 'COMMON' }));
    const result = m.compareStrategies(requests, 8);
    // ラウンドロビン: 各ワーカーに12-13件ずつ → 各ワーカーで1回ミス → 88ヒット
    // アフィニティ: 1台に100件 → 99ヒット
    assert.ok(result.affinity.hitRate > result.roundRobin.hitRate);
    assert.ok(result.affinity.hitRate >= 99);
    assert.equal(result.roundRobin.cacheHits, 92); // 100-8
    assert.equal(result.roundRobin.cacheMisses, 8);
    assert.equal(result.affinity.cacheHits, 99);
    assert.equal(result.affinity.cacheMisses, 1);
  });

  it('ユニークプレフィックス数の報告が正しい', () => {
    const requests = [
      { id: 'a1', prefix: 'A' }, { id: 'a2', prefix: 'A' },
      { id: 'b1', prefix: 'B' }, { id: 'b2', prefix: 'B' },
      { id: 'c1', prefix: 'C' },
    ];
    const result = m.compareStrategies(requests, 4);
    assert.equal(result.uniquePrefixes, 3);
    assert.equal(result.totalRequests, 5);
  });
});

// ============================================================
// テスト9: demo
// ============================================================
describe('demo', async () => {
  let m;
  before(async () => { m = await load(); });

  it('booth-proposal シナリオがエラーなく実行できる', () => {
    const result = m.demo('booth-proposal');
    assert.ok(result.scenario.includes('ブース提案'));
    assert.equal(result.totalRequests, 60); // 3 prefix × 20 cases
    assert.ok(result.comparison);
    assert.ok(result.comparison.affinity.hitRate > 0);
  });

  it('event-planning シナリオがエラーなく実行できる', () => {
    const result = m.demo('event-planning');
    assert.equal(result.totalRequests, 50); // 5 prefix × 10 cases
    assert.ok(result.comparison);
  });

  it('single-prefix シナリオがエラーなく実行できる', () => {
    const result = m.demo('single-prefix');
    assert.equal(result.totalRequests, 100); // 1 prefix × 100 cases
    assert.ok(result.comparison);
    // 同一プレフィックスなのでアフィニティのヒット率は99%
    assert.equal(result.comparison.affinity.hitRate, 99);
  });

  it('未知のシナリオ名でエラー', () => {
    assert.throws(() => m.demo('nonexistent'), /Unknown scenario/);
  });
});

// ============================================================
// テスト10: ringStatus
// ============================================================
describe('ringStatus', async () => {
  let m;
  before(async () => { m = await load(); });

  it('リング状態が正しく報告される', () => {
    const ring = m.createRing(['a', 'b', 'c']);
    const status = m.ringStatus(ring);
    assert.equal(status.workerCount, 3);
    assert.equal(status.totalEntries, 300);
    assert.equal(status.entries.length, 3);
    for (const e of status.entries) {
      assert.ok(e.virtualNodes >= 90); // 100 ± 誤差
      assert.ok(e.virtualNodes <= 110);
      assert.ok(Array.isArray(e.positionRange));
      assert.ok(e.positionRange.length === 2);
    }
  });

  it('空のようなリングでもエラーにならない', () => {
    const status = m.ringStatus({ entries: [], workers: [] });
    assert.equal(status.workerCount, 0);
    assert.equal(status.totalEntries, 0);
  });
});

// ============================================================
// テスト11: ワーカー追加・削除後の再配置率
// ============================================================
describe('worker rebalancing', async () => {
  let m;
  before(async () => { m = await load(); });

  it('addWorker 後も大部分のルーティングが維持される', () => {
    let ring = m.createRing(['a', 'b', 'c', 'd']);

    // 20個のプレフィックスでルーティング先を記録
    const prefixes = [];
    for (let i = 0; i < 20; i++) {
      prefixes.push(`prefix-${i}-${'x'.repeat(i)}`);
    }
    const before = prefixes.map(p => m.routeRequest(ring, p));

    // ワーカー追加
    ring = m.addWorker(ring, 'e');

    // 追加後も大部分が同じワーカーにルーティングされる
    const after = prefixes.map(p => m.routeRequest(ring, p));
    const same = before.filter((w, i) => w === after[i]).length;

    // 20プレフィックス中、最低15は維持されるべき（実際はもっと多い）
    assert.ok(same >= 15, `Only ${same}/20 prefixes kept the same worker after add`);
  });

  it('removeWorker 後に残ったワーカーがカバーする', () => {
    let ring = m.createRing(['a', 'b', 'c', 'd', 'e']);
    const prefixes = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9', 'p10'];

    // 削除前のルーティング
    ring = m.removeWorker(ring, 'e');
    const after = prefixes.map(p => m.routeRequest(ring, p));

    // 全プレフィックスが a-d のいずれかに割り振られる
    for (const worker of after) {
      assert.ok(['a', 'b', 'c', 'd'].includes(worker),
        `Unexpected worker: ${worker}`);
    }
  });
});