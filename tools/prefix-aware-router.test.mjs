import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ConsistentHashRing, extractRoutingPrefix, normalizePrefix,
  routeRequest, routeBatch, simulateRouting,
} from './prefix-aware-router.mjs';

// ═══════════════════════════════════════════════════════════════════════════════
// ConsistentHashRing
// ═══════════════════════════════════════════════════════════════════════════════

test('ConsistentHashRing: routes same key to same worker', () => {
  const ring = new ConsistentHashRing(['a', 'b', 'c'], { virtualNodes: 150 });
  const key = 'test-prefix-content';
  const first = ring.getNode(key);
  const second = ring.getNode(key);
  const third = ring.getNode(key);
  assert.equal(first, second);
  assert.equal(second, third);
});

test('ConsistentHashRing: different keys may map to different workers', () => {
  const ring = new ConsistentHashRing(['a', 'b', 'c'], { virtualNodes: 150 });
  // Use many different keys; at least some should differ
  const results = new Set(
    Array.from({ length: 100 }, (_, i) => ring.getNode(`key-${i}`))
  );
  // With 3 workers and 100 keys, very unlikely all map to the same worker
  assert.ok(results.size > 1, 'Expected at least 2 different workers for 100 keys');
});

test('ConsistentHashRing: addWorker includes new worker in distribution', () => {
  const ring = new ConsistentHashRing(['a', 'b'], { virtualNodes: 150 });
  const before = new Set(ring.getWorkers());
  assert.equal(before.size, 2);

  ring.addWorker('c');
  const after = new Set(ring.getWorkers());
  assert.equal(after.size, 3);
  assert.ok(after.has('c'));
});

test('ConsistentHashRing: removeWorker excludes worker from distribution', () => {
  const ring = new ConsistentHashRing(['a', 'b', 'c'], { virtualNodes: 150 });
  ring.removeWorker('b');
  const workers = ring.getWorkers();
  assert.equal(workers.length, 2);
  assert.ok(!workers.includes('b'));
});

test('ConsistentHashRing: keys redistribute minimally on worker removal', () => {
  const ring1 = new ConsistentHashRing(['a', 'b', 'c'], { virtualNodes: 150 });
  const keys = Array.from({ length: 1000 }, (_, i) => `test-key-${i}`);

  // Map before removal
  const before = keys.map((k) => ring1.getNode(k));

  // Remove one worker
  ring1.removeWorker('b');
  const after = keys.map((k) => ring1.getNode(k));

  // Count how many keys changed worker
  const changed = before.filter((w, i) => w === 'b' || after[i] !== before[i]);
  // Only keys that were on 'b' should have moved (plus edge cases)
  const wasB = before.filter((w) => w === 'b').length;
  // At most keys that were on 'b' should change (+/- fringe), total changed < wasB * 2
  assert.ok(changed.length <= wasB * 1.5 + 5,
    `Expected minimal redistribution, ${changed.length} changed out of ${wasB} on 'b'`);
});

test('ConsistentHashRing: distribution is relatively even', () => {
  const ring = new ConsistentHashRing(
    Array.from({ length: 8 }, (_, i) => `worker-${i}`),
    { virtualNodes: 150 }
  );
  const stats = ring.distributionStats(10000);
  const ideal = 10000 / 8;
  // Each worker should be within 10% of ideal
  for (const [worker, count] of Object.entries(stats.distribution)) {
    const ratio = count / ideal;
    assert.ok(ratio >= 0.85 && ratio <= 1.15,
      `Worker ${worker} has ${count} keys (${Math.round(ratio * 100)}% of ideal ${ideal})`);
  }
});

test('ConsistentHashRing: empty ring throws on getNode', () => {
  const ring = new ConsistentHashRing([], { virtualNodes: 150 });
  assert.throws(() => ring.getNode('any-key'), /No workers/);
});

test('ConsistentHashRing: adding existing worker is idempotent', () => {
  const ring = new ConsistentHashRing(['a', 'b'], { virtualNodes: 150 });
  const beforeCount = ring.ring.length;
  ring.addWorker('a'); // already exists
  assert.equal(ring.ring.length, beforeCount);
});

test('ConsistentHashRing: removing non-existent worker is idempotent', () => {
  const ring = new ConsistentHashRing(['a', 'b'], { virtualNodes: 150 });
  const beforeCount = ring.ring.length;
  ring.removeWorker('nonexistent');
  assert.equal(ring.ring.length, beforeCount);
});

// ═══════════════════════════════════════════════════════════════════════════════
// extractRoutingPrefix
// ═══════════════════════════════════════════════════════════════════════════════

test('extractRoutingPrefix: uses x-cache-group header first', () => {
  const request = {
    'x-cache-group': 'booth-proposal',
    system: 'デフォルトシステムプロンプト',
  };
  const prefix = extractRoutingPrefix(request);
  assert.ok(prefix.startsWith('__group__:'));
  assert.ok(prefix.includes('booth-proposal'));
});

test('extractRoutingPrefix: falls back to system prompt', () => {
  const request = {
    system: 'あなたは展示会ブースのデザイナーです。',
  };
  const prefix = extractRoutingPrefix(request);
  assert.equal(prefix, request.system);
});

test('extractRoutingPrefix: extracts from messages array', () => {
  const request = {
    messages: [
      { role: 'system', content: 'システムメッセージ内容' },
      { role: 'user', content: 'ユーザー入力' },
    ],
  };
  const prefix = extractRoutingPrefix(request);
  assert.equal(prefix, 'システムメッセージ内容');
});

test('extractRoutingPrefix: falls back to first message when no system', () => {
  const request = {
    messages: [
      { role: 'user', content: '最初のユーザーメッセージ' },
    ],
  };
  const prefix = extractRoutingPrefix(request);
  assert.equal(prefix, '最初のユーザーメッセージ');
});

test('extractRoutingPrefix: respects prefixChars limit', () => {
  const request = {
    system: 'A'.repeat(100),
  };
  const prefix = extractRoutingPrefix(request, { prefixChars: 10 });
  assert.equal(prefix.length, 10);
});

test('extractRoutingPrefix: returns empty for null request', () => {
  assert.equal(extractRoutingPrefix(null), '');
  assert.equal(extractRoutingPrefix(undefined), '');
});

test('extractRoutingPrefix: returns empty for empty request', () => {
  assert.equal(extractRoutingPrefix({}), '');
});

test('extractRoutingPrefix: reads from headers object', () => {
  const request = {
    headers: { 'x-cache-group': 'custom-group' },
  };
  const prefix = extractRoutingPrefix(request);
  assert.ok(prefix.includes('custom-group'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// normalizePrefix
// ═══════════════════════════════════════════════════════════════════════════════

test('normalizePrefix: normalizes CRLF to LF', () => {
  assert.equal(normalizePrefix('line1\r\nline2\r\n'), 'line1\nline2');
});

test('normalizePrefix: removes trailing whitespace', () => {
  assert.equal(normalizePrefix('hello   \nworld\t\n'), 'hello\nworld');
});

test('normalizePrefix: handles empty input', () => {
  assert.equal(normalizePrefix(''), '');
  assert.equal(normalizePrefix(null), '');
});

test('normalizePrefix: preserves meaningful spaces', () => {
  const input = 'これは 意味のある スペースです';
  assert.equal(normalizePrefix(input), input);
});

// ═══════════════════════════════════════════════════════════════════════════════
// routeRequest / routeBatch
// ═══════════════════════════════════════════════════════════════════════════════

test('routeRequest: same prefix → same worker', () => {
  const workers = Array.from({ length: 8 }, (_, i) => `worker-${i}`);
  const ring = new ConsistentHashRing(workers, { virtualNodes: 150 });

  const req1 = { system: '共通のシステムプロンプトです。' };
  const req2 = { system: '共通のシステムプロンプトです。' };

  const r1 = routeRequest(req1, ring);
  const r2 = routeRequest(req2, ring);

  assert.equal(r1.worker, r2.worker);
  assert.equal(r1.prefixHash, r2.prefixHash);
});

test('routeRequest: different prefix → possibly different worker', () => {
  const workers = Array.from({ length: 8 }, (_, i) => `worker-${i}`);
  const ring = new ConsistentHashRing(workers, { virtualNodes: 150 });

  const req1 = { system: 'システムプロンプトA' };
  const req2 = { system: 'システムプロンプトB' };

  // These should have different prefix hashes
  assert.notEqual(
    routeRequest(req1, ring).prefixHash,
    routeRequest(req2, ring).prefixHash
  );
});

test('routeBatch: groups requests by prefix', () => {
  const workers = Array.from({ length: 4 }, (_, i) => `worker-${i}`);
  const ring = new ConsistentHashRing(workers, { virtualNodes: 150 });

  const requests = [
    { id: 'a1', system: 'prefix-A' },
    { id: 'a2', system: 'prefix-A' },
    { id: 'b1', system: 'prefix-B' },
    { id: 'b2', system: 'prefix-B' },
    { id: 'b3', system: 'prefix-B' },
    { id: 'c1', system: 'prefix-C' },
  ];

  const result = routeBatch(requests, ring);
  // 3 distinct prefixes
  assert.equal(result.stats.groups, 3);
  assert.equal(result.stats.totalRequests, 6);

  // Each group should have the expected count
  const groupSizes = Object.values(result.assignments).map((r) => r.length);
  assert.ok(groupSizes.includes(2)); // prefix-A
  assert.ok(groupSizes.includes(3)); // prefix-B
  assert.ok(groupSizes.includes(1)); // prefix-C
});

// ═══════════════════════════════════════════════════════════════════════════════
// simulateRouting
// ═══════════════════════════════════════════════════════════════════════════════

test('simulateRouting: prefix-aware outperforms random routing', () => {
  const result = simulateRouting({
    workerCount: 8,
    requestGroups: 3,
    requestsPerGroup: 5,
    rounds: 500,
    prefixSharedRatio: 0.4,
  });

  // Prefix-aware hit rate should be higher than random hit rate
  assert.ok(
    result.prefixAwareRouting.hitRate > result.randomRouting.hitRate,
    `Expected prefix-aware (${result.prefixAwareRouting.hitRate}%) > random (${result.randomRouting.hitRate}%)`
  );

  // Absolute improvement should be positive
  assert.ok(result.absoluteImprovement > 0, `Expected positive improvement, got ${result.absoluteImprovement}`);
});

test('simulateRouting: random routing matches 1/N expectation approximately', () => {
  const result = simulateRouting({
    workerCount: 8,
    requestGroups: 5,
    requestsPerGroup: 3,
    rounds: 500,
    prefixSharedRatio: 0.5,
  });

  // Random routing should be near 12.5% (1/8) within reasonable tolerance
  // It also includes unique requests which dilute the rate further
  assert.ok(
    result.randomRouting.hitRate < 25,
    `Expected random routing < 25%, got ${result.randomRouting.hitRate}%`
  );
});

test('simulateRouting: reports valid structure', () => {
  const result = simulateRouting();
  assert.ok(result.config);
  assert.ok(result.randomRouting);
  assert.ok(result.prefixAwareRouting);
  assert.ok(typeof result.absoluteImprovement === 'number');
  assert.ok(typeof result.relativeImprovement === 'number');
  assert.ok(result.note);
});