#!/usr/bin/env node
// Prefix-aware request router — route requests with the same system prompt prefix
// to the same worker for maximum KV cache hit rate.
// X-0066: Prefix-recognition routing for cache hit improvement (+4.5% overall).
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

const ROUTER_STORE_DIR = path.join(process.env.ORGIAST_HOME || os.homedir(), '.claude', 'prefix-router');

// ═══════════════════════════════════════════════════════════════════════════════
// Consistent Hash Ring (一貫性ハッシュリング)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Consistent hash ring with virtual nodes for even key distribution.
 * Maps string keys to worker nodes, ensuring minimal remapping when nodes change.
 */
export class ConsistentHashRing {
  /**
   * @param {string[]} workers  Worker node identifiers (URLs or names).
   * @param {object} [options]
   * @param {number} [options.virtualNodes=150]  Virtual nodes per worker for balance.
   */
  constructor(workers = [], { virtualNodes = 150 } = {}) {
    this.virtualNodes = virtualNodes;
    this.ring = []; // [{ hash: number, worker: string }]
    this.workers = new Set();
    for (const w of workers) {
      this.addWorker(w);
    }
  }

  /**
   * Add a worker to the ring.
   * @param {string} worker
   */
  addWorker(worker) {
    if (this.workers.has(worker)) return;
    this.workers.add(worker);
    for (let i = 0; i < this.virtualNodes; i++) {
      const hash = this._hash(`${worker}:vnode:${i}`);
      this.ring.push({ hash, worker });
    }
    this.ring.sort((a, b) => a.hash - b.hash);
  }

  /**
   * Remove a worker from the ring.
   * @param {string} worker
   */
  removeWorker(worker) {
    if (!this.workers.has(worker)) return;
    this.workers.delete(worker);
    this.ring = this.ring.filter((entry) => entry.worker !== worker);
    // No re-sort needed after filter
  }

  /**
   * Get the worker node responsible for a given key.
   * Uses consistent hashing: same key → same worker (until ring changes).
   * @param {string} key
   * @returns {string}  Worker node identifier.
   */
  getNode(key) {
    if (this.ring.length === 0) throw new Error('No workers in the ring');
    const hash = this._hash(key);
    // Binary search for the first node with hash >= key hash
    let lo = 0;
    let hi = this.ring.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ring[mid].hash >= hash) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    // If key hash exceeds all node hashes, wrap to first node
    if (this.ring[lo].hash < hash) {
      return this.ring[0].worker;
    }
    return this.ring[lo].worker;
  }

  /**
   * Get all workers currently in the ring.
   * @returns {string[]}
   */
  getWorkers() {
    return [...this.workers];
  }

  /**
   * Number of distinct workers.
   * @returns {number}
   */
  get workerCount() {
    return this.workers.size;
  }

  /**
   * Statistics: distribution of keys across workers.
   * @param {number} sampleKeys  Number of sample keys to test (default: 10000).
   * @returns {{ distribution: Record<string,number>, stdDev: number, min: number, max: number }}
   */
  distributionStats(sampleKeys = 10000) {
    const counts = {};
    for (const w of this.workers) counts[w] = 0;
    for (let i = 0; i < sampleKeys; i++) {
      const key = `test-key-${i}-${Math.random().toString(36).slice(2, 8)}`;
      const worker = this.getNode(key);
      counts[worker] = (counts[worker] || 0) + 1;
    }
    const vals = Object.values(counts);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
    return {
      distribution: counts,
      stdDev: Math.round(Math.sqrt(variance) * 100) / 100,
      min: Math.min(...vals),
      max: Math.max(...vals),
      total: sampleKeys,
      idealPerWorker: Math.round(mean),
    };
  }

  _hash(key) {
    const hash = crypto.createHash('md5').update(String(key), 'utf8').digest();
    // Use first 4 bytes as unsigned 32-bit integer
    return hash.readUInt32BE(0);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Prefix extraction
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Extract a stable routing prefix from a request payload.
 * Priority order: x-cache-group header > system prompt first N chars > fallback.
 *
 * @param {object} request  LLM request payload ({ system, messages, headers, ... }).
 * @param {object} [options]
 * @param {number} [options.prefixChars=4096]  Max chars to use from system prompt.
 * @returns {string}  Stable prefix for routing.
 */
export function extractRoutingPrefix(request, { prefixChars = 4096 } = {}) {
  if (!request) return '';

  // 1. Custom cache-group header (most explicit)
  const group = request['x-cache-group'] || request.headers?.['x-cache-group'];
  if (group && typeof group === 'string' && group.trim().length > 0) {
    return `__group__:${group.trim()}`;
  }

  // 2. System prompt text
  let systemText = '';
  if (typeof request.system === 'string') {
    systemText = request.system;
  } else if (Array.isArray(request.messages)) {
    const sysMsg = request.messages.find((m) => m.role === 'system');
    if (sysMsg && typeof sysMsg.content === 'string') {
      systemText = sysMsg.content;
    }
  }

  // 3. Fallback: first message content
  if (!systemText && Array.isArray(request.messages) && request.messages.length > 0) {
    const first = request.messages[0];
    systemText = typeof first.content === 'string' ? first.content : '';
  }

  return systemText ? systemText.slice(0, prefixChars) : '';
}

/**
 * Normalize a prefix for byte-level consistent routing.
 * Striws trailing whitespace and normalizes line endings.
 * @param {string} prefix  Raw prefix text.
 * @returns {string}  Normalized prefix.
 */
export function normalizePrefix(prefix) {
  return String(prefix || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[ \t]+$/gm, '') // trailing ws per line
    .replace(/\s+$/, '');     // trailing ws at end
}

// ═══════════════════════════════════════════════════════════════════════════════
// Router
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Route a request to a worker based on its prefix.
 *
 * @param {object} request  LLM request payload.
 * @param {ConsistentHashRing} ring  Consistent hash ring.
 * @param {object} [options]
 * @param {number} [options.prefixChars=4096]  Max chars for prefix extraction.
 * @returns {{ worker: string, prefix: string, prefixHash: string, normalized: boolean }}
 */
export function routeRequest(request, ring, { prefixChars = 4096 } = {}) {
  const prefix = extractRoutingPrefix(request, { prefixChars });
  const normalized = normalizePrefix(prefix);
  const prefixHash = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
  const worker = ring.getNode(prefixHash);
  return { worker, prefix, prefixHash, normalized: prefix !== normalized };
}

/**
 * Route a batch of requests, grouping by prefix for optimal cache usage.
 *
 * @param {object[]} requests  Array of LLM request payloads.
 * @param {ConsistentHashRing} ring  Consistent hash ring.
 * @param {object} [options]
 * @returns {object}  { assignments: Record<string, object[]>, stats: { groups: number, workersUsed: number } }
 */
export function routeBatch(requests, ring, options = {}) {
  const groups = {};
  for (const req of requests) {
    const { prefixHash } = routeRequest(req, ring, options);
    if (!groups[prefixHash]) groups[prefixHash] = [];
    groups[prefixHash].push(req);
  }
  const workersUsed = new Set();
  for (const hash of Object.keys(groups)) {
    const worker = ring.getNode(hash);
    workersUsed.add(worker);
  }
  return {
    assignments: groups,
    stats: {
      groups: Object.keys(groups).length,
      workersUsed: workersUsed.size,
      totalRequests: requests.length,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Simulation
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simulate cache hit rate for random vs prefix-aware routing.
 *
 * @param {object} [options]
 * @param {number} [options.workerCount=8]  Number of worker nodes.
 * @param {number} [options.requestGroups=3]  Number of distinct prefix groups.
 * @param {number} [options.requestsPerGroup=5]  Requests per prefix group.
 * @param {number} [options.rounds=1000]  Simulation rounds for statistical avg.
 * @param {number} [options.prefixSharedRatio=0.4]  Ratio of requests sharing a prefix (0..1).
 * @returns {object} Simulation results.
 */
export function simulateRouting({
  workerCount = 8,
  requestGroups = 3,
  requestsPerGroup = 5,
  rounds = 1000,
  prefixSharedRatio = 0.4,
} = {}) {
  // Build prefix-aware ring
  const workers = Array.from({ length: workerCount }, (_, i) => `worker-${i}`);
  const ring = new ConsistentHashRing(workers, { virtualNodes: 150 });

  // Generate prefix groups
  const prefixGroups = Array.from({ length: requestGroups }, (_, g) => ({
    id: `prefix-group-${g}`,
    prefix: `あなたは展示会ブースのプロジェクトマネージャーです。案件グループ${String.fromCharCode(65 + g)}の提案を生成してください。以下のガイドラインに従ってください：ブースサイズは標準小間（2.7m×6m）、使用可能な構造材はアルミフレーム...`,
    requests: Array.from({ length: requestsPerGroup }, (_, r) => ({
      id: `req-g${g}-${r}`,
      system: `あなたは展示会ブースのプロジェクトマネージャーです。案件グループ${String.fromCharCode(65 + g)}の提案を生成してください。以下のガイドラインに従ってください：ブースサイズは標準小間（2.7m×6m）、使用可能な構造材はアルミフレーム...`,
      suffix: `案件固有情報: クライアント ${r}、予算: ${(r + 1) * 100}万円`,
    })),
  }));

  // Also generate some unique-prefix requests (not shared)
  const uniquePrefixCount = Math.round(
    (prefixGroups.reduce((s, g) => s + g.requests.length, 0) / prefixSharedRatio) * (1 - prefixSharedRatio)
  );
  const uniqueRequests = Array.from({ length: uniquePrefixCount }, (_, i) => ({
    id: `unique-${i}`,
    system: `固有システムプロンプト: ${crypto.randomUUID()}`,
    suffix: `固有データ: ${i}`,
  }));

  let randomHits = 0;
  let randomTotal = 0;
  let prefixHits = 0;
  let prefixTotal = 0;

  for (let round = 0; round < rounds; round++) {
    // --- Random routing simulation ---
    for (const group of prefixGroups) {
      for (let i = 0; i < group.requests.length; i++) {
        const workerIdx = Math.floor(Math.random() * workerCount);
        const prevWorkerIdx = i === 0 ? -1 : Math.floor(Math.random() * workerCount); // Random for every req
        if (i > 0 && prevWorkerIdx === workerIdx) {
          randomHits++;
        }
        randomTotal++;
      }
    }
    // Unique requests have no cache hits in either mode
    for (const _ of uniqueRequests) {
      randomTotal++;
      prefixTotal++;
    }

    // --- Prefix-aware routing simulation ---
    const ringRound = new ConsistentHashRing(workers, { virtualNodes: 150 });
    for (const group of prefixGroups) {
      const firstWorker = ringRound.getNode(group.prefix);
      for (let i = 0; i < group.requests.length; i++) {
        const worker = ringRound.getNode(group.prefix);
        if (i > 0 && worker === firstWorker) {
          prefixHits++;
        }
        prefixTotal++;
      }
    }
  }

  const sharedCount = prefixGroups.reduce((s, g) => s + g.requests.length, 0);
  const totalCount = sharedCount + uniquePrefixCount;
  const sharedRatio = sharedCount / totalCount;
  const randomHitRate = randomHits / randomTotal;
  const prefixHitRate = prefixHits / prefixTotal;
  const improvement = ((prefixHitRate - randomHitRate) / randomHitRate) * 100;

  return {
    config: { workerCount, requestGroups, requestsPerGroup, rounds, prefixSharedRatio: Math.round(sharedRatio * 100) / 100 },
    randomRouting: {
      hitRate: Math.round(randomHitRate * 10000) / 100,
      estimate: `${Math.round((1 / workerCount) * 10000) / 100}% (1/N = 1/${workerCount})`,
    },
    prefixAwareRouting: {
      hitRate: Math.round(prefixHitRate * 10000) / 100,
      estimate: '~100% (within shared prefix groups)',
    },
    absoluteImprovement: Math.round((prefixHitRate - randomHitRate) * 10000) / 100,
    relativeImprovement: Math.round(improvement * 100) / 100,
    sharedRatio: Math.round(sharedRatio * 10000) / 100,
    totalRequestsPerRound: totalCount,
    note: `システム全体のキャッシュヒット向上: ランダム ${Math.round(randomHitRate * 10000) / 100}% → プレフィックス認識 ${Math.round(prefixHitRate * 10000) / 100}%（絶対値 +${Math.round((prefixHitRate - randomHitRate) * 10000) / 100}%、改善率 +${Math.round(improvement * 100) / 100}%）`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════════

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.includes('--simulate')) {
    const workerCount = parseInt(args.find((a) => a.startsWith('--workers='))?.split('=')[1] || '8', 10);
    const result = simulateRouting({ workerCount });
    console.log(JSON.stringify(result, null, 2));
  } else if (args.includes('--route')) {
    const workerCount = parseInt(args.find((a) => a.startsWith('--workers='))?.split('=')[1] || '8', 10);
    const workers = Array.from({ length: workerCount }, (_, i) => `worker-${i}`);
    const ring = new ConsistentHashRing(workers, { virtualNodes: 150 });

    // Read request from stdin as JSON or first arg as inline JSON
    const inputFile = args[args.indexOf('--route') + 1];
    let request;
    if (inputFile && fs.existsSync(inputFile)) {
      request = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    } else if (inputFile) {
      request = JSON.parse(inputFile);
    } else {
      // Default demo request
      request = {
        id: 'demo-request',
        system: 'あなたは展示会ブースのプロジェクトマネージャーです。',
        messages: [
          { role: 'user', content: '東京ビッグサイトの建設フェア向けの提案をください。' },
        ],
      };
    }

    const result = routeRequest(request, ring);
    const stats = ring.distributionStats(10000);
    console.log(JSON.stringify({ route: result, ringStats: stats }, null, 2));
  } else if (args.includes('--distribute')) {
    const workerCount = parseInt(args.find((a) => a.startsWith('--workers='))?.split('=')[1] || '8', 10);
    const workers = Array.from({ length: workerCount }, (_, i) => `worker-${i}`);
    const ring = new ConsistentHashRing(workers, { virtualNodes: 150 });
    const stats = ring.distributionStats(10000);
    console.log(JSON.stringify(stats, null, 2));
  } else if (args.includes('--batch')) {
    const workerCount = parseInt(args.find((a) => a.startsWith('--workers='))?.split('=')[1] || '8', 10);
    const workers = Array.from({ length: workerCount }, (_, i) => `worker-${i}`);
    const ring = new ConsistentHashRing(workers, { virtualNodes: 150 });

    // Generate batch of requests
    const batchSize = parseInt(args.find((a) => a.startsWith('--batch-size='))?.split('=')[1] || '20', 10);
    const prefixGroups = 4;
    const requests = Array.from({ length: batchSize }, (_, i) => ({
      id: `batch-req-${i}`,
      system: `あなたは展示会ブースのプロジェクトマネージャーです。案件グループ${String.fromCharCode(65 + (i % prefixGroups))}の提案を生成してください。`,
      suffix: `案件固有情報: クライアント ${i}`,
    }));

    const result = routeBatch(requests, ring);
    console.log(JSON.stringify({
      assignments: Object.fromEntries(
        Object.entries(result.assignments).map(([hash, reqs]) => [
          hash,
          { count: reqs.length, worker: ring.getNode(hash), requestIds: reqs.map(r => r.id) },
        ])
      ),
      stats: result.stats,
    }, null, 2));
  } else {
    // Default: comprehensive demo
    const result = simulateRouting({ workerCount: 8 });
    console.log('=== Prefix-Aware Routing Simulator (X-0066) ===\n');
    console.log(JSON.stringify(result, null, 2));
    console.log('\n---\n使い方:');
    console.log('  --simulate         キャッシュヒット率シミュレーション（デフォルト）');
    console.log('  --route [file|json] リクエストをルーティング');
    console.log('  --distribute       ハッシュリングの分散統計');
    console.log('  --batch            バッチルーティング（プレフィックスグループ化）');
    console.log('  --workers=<N>      ワーカー数（デフォルト: 8）');
  }
}