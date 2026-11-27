#!/usr/bin/env node
// tools/x0098-prefix-router.mjs — X-0098: マルチワーカープレフィックスアウェア・ルーティング
//
// 複数ワーカー環境で同一プレフィックスのリクエストを常に同じワーカーへ
// ルーティングするコンシステントハッシュリング実装。
// ラウンドロビンと比較しキャッシュヒット率・TTFT・メモリ使用量を改善する。
//
// 使い方:
//   node tools/x0098-prefix-router.mjs --demo                  デモ実行
//   node tools/x0098-prefix-router.mjs --demo booth-proposal   ブース提案シナリオ
//   node tools/x0098-prefix-router.mjs --route <prefix> --workers 8
//   node tools/x0098-prefix-router.mjs --ring --workers 8
//   node tools/x0098-prefix-router.mjs --simulate <requests.json>
//   node tools/x0098-prefix-router.mjs --help

import fs from 'node:fs';
import crypto from 'node:crypto';
import { isEntry } from './is-entry.mjs';

// ───────── 定数 ─────────

const VIRTUAL_NODES_PER_WORKER = 100;
const RING_SIZE = 2 ** 32;

// ───────── ハッシュ ─────────

/**
 * FNV-1a ハッシュ（32bit）のプレフィックス版。
 * 文字列から 0〜RING_SIZE-1 の値を返す。
 */
export function hashPrefix(prefix) {
  if (typeof prefix !== 'string') throw new TypeError('prefix must be a string');
  const buf = Buffer.from(prefix.normalize('NFC'), 'utf8');
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < buf.length; i++) {
    hash ^= buf[i];
    hash = Math.imul(hash, 0x01000193); // FNV prime
    hash >>>= 0; // force unsigned 32-bit
  }
  return hash % RING_SIZE;
}

/**
 * 文字列の SHA-256 ハッシュをリング上の位置にマッピング。
 * FNV-1a より衝突耐性が高いが、若干遅い。
 */
export function hashPrefixSha256(prefix) {
  if (typeof prefix !== 'string') throw new TypeError('prefix must be a string');
  const hash = crypto.createHash('sha256').update(prefix.normalize('NFC'), 'utf8').digest();
  return hash.readUInt32BE(0) % RING_SIZE;
}

// ───────── コンシステントハッシュリング ─────────

/**
 * リングエントリ
 * @typedef {Object} RingEntry
 * @property {number} position - リング上の位置 (0〜RING_SIZE-1)
 * @property {string} worker - ワーカーID
 * @property {number} virtualIndex - 仮想ノードインデックス
 */

/**
 * コンシステントハッシュリングを構築。
 * 各ワーカーに VIRTUAL_NODES_PER_WORKER 個の仮想ノードを配置。
 *
 * @param {string[]} workers - ワーカーIDの配列
 * @param {object} [options]
 * @param {number} [options.virtualNodes=100] - ワーカーあたり仮想ノード数
 * @param {boolean} [options.useSha256=false] - SHA-256 を使用（デフォルトは FNV-1a）
 * @returns {{ entries: RingEntry[], workers: string[] }}
 */
export function createRing(workers, options = {}) {
  if (!Array.isArray(workers) || workers.length === 0) {
    throw new Error('workers must be a non-empty array');
  }
  const vnodes = options.virtualNodes ?? VIRTUAL_NODES_PER_WORKER;
  const hashFn = options.useSha256 ? hashPrefixSha256 : hashPrefix;
  const entries = [];

  for (const worker of workers) {
    for (let i = 0; i < vnodes; i++) {
      const key = `${worker}:vnode:${i}`;
      const position = hashFn(key);
      entries.push({ position, worker, virtualIndex: i });
    }
  }

  // 位置でソート
  entries.sort((a, b) => a.position - b.position);

  return { entries, workers: [...workers] };
}

/**
 * リングから、指定されたプレフィックスの担当ワーカーを返す。
 *
 * @param {{ entries: RingEntry[], workers: string[] }} ring - createRing の戻り値
 * @param {string} prefix - ルーティングするプレフィックス
 * @param {object} [options]
 * @param {boolean} [options.useSha256=false]
 * @returns {string} 担当ワーカーID
 */
export function routeRequest(ring, prefix, options = {}) {
  if (!ring || !ring.entries || ring.entries.length === 0) {
    throw new Error('ring must contain entries');
  }
  const hashFn = options.useSha256 ? hashPrefixSha256 : hashPrefix;
  const pos = hashFn(prefix);

  // 二分探索で pos 以上の最小位置を探す
  let lo = 0;
  let hi = ring.entries.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ring.entries[mid].position < pos) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }

  // ラップアラウンド: pos 以上のエントリが無かったら先頭
  if (ring.entries[lo].position < pos) {
    return ring.entries[0].worker;
  }
  return ring.entries[lo].worker;
}

/**
 * ワーカーをリングに追加（最小限の再配置）。
 * 追加後の新しいリングを返す。
 *
 * @param {{ entries: RingEntry[], workers: string[] }} ring
 * @param {string} worker - 追加するワーカーID
 * @param {object} [options]
 * @param {number} [options.virtualNodes=100]
 * @param {boolean} [options.useSha256=false]
 * @returns {{ entries: RingEntry[], workers: string[] }}
 */
export function addWorker(ring, worker, options = {}) {
  if (ring.workers.includes(worker)) return ring; // 既存
  const vnodes = options.virtualNodes ?? VIRTUAL_NODES_PER_WORKER;
  const hashFn = options.useSha256 ? hashPrefixSha256 : hashPrefix;
  const newEntries = [];

  for (let i = 0; i < vnodes; i++) {
    const key = `${worker}:vnode:${i}`;
    newEntries.push({ position: hashFn(key), worker, virtualIndex: i });
  }

  const merged = [...ring.entries, ...newEntries].sort((a, b) => a.position - b.position);
  return { entries: merged, workers: [...ring.workers, worker] };
}

/**
 * ワーカーをリングから削除（最小限の再配置）。
 * 削除後の新しいリングを返す。
 *
 * @param {{ entries: RingEntry[], workers: string[] }} ring
 * @param {string} worker - 削除するワーカーID
 * @returns {{ entries: RingEntry[], workers: string[] }}
 */
export function removeWorker(ring, worker) {
  const idx = ring.workers.indexOf(worker);
  if (idx < 0) return ring; // 存在しない
  const filtered = ring.entries.filter(e => e.worker !== worker);
  return { entries: filtered, workers: ring.workers.filter(w => w !== worker) };
}

// ───────── シミュレーション ─────────

/**
 * @typedef {Object} Request
 * @property {string} id - リクエストID
 * @property {string} prefix - プレフィックス（同一なら同一グループ）
 * @property {number} [staticLen] - 静的プレフィックス長（文字数）
 * @property {number} [dynamicLen] - 動的部分長（文字数）
 */

/**
 * ラウンドロビン戦略でのキャッシュ統計。
 * 各ワーカーに均等にリクエストが割り振られる前提。
 *
 * @param {Request[]} requests - リクエスト一覧
 * @param {number} workerCount - ワーカー数
 * @returns {object} 統計情報
 */
export function simulateRoundRobin(requests, workerCount) {
  if (!Array.isArray(requests) || requests.length === 0) {
    return { totalRequests: 0, cacheHits: 0, cacheMisses: 0, hitRate: 0, workerAssignments: {} };
  }

  // プレフィックスグループごとに集計
  const groups = {};
  for (const req of requests) {
    if (!groups[req.prefix]) groups[req.prefix] = [];
    groups[req.prefix].push(req);
  }

  let totalHits = 0;
  let totalMisses = 0;
  const workerAssignments = {};

  for (const [prefix, group] of Object.entries(groups)) {
    // ラウンドロビン: 各リクエストは workerCount 台に順番に振られる
    for (let i = 0; i < group.length; i++) {
      const worker = `worker-${(i % workerCount)}`;
      if (!workerAssignments[worker]) workerAssignments[worker] = { requests: 0, hits: 0, misses: 0 };
      workerAssignments[worker].requests++;
      if (i >= workerCount) {
        // 同じワーカーに2周目以降が来ればキャッシュヒット
        workerAssignments[worker].hits++;
        totalHits++;
      } else {
        workerAssignments[worker].misses++;
        totalMisses++;
      }
    }
  }

  return {
    totalRequests: requests.length,
    cacheHits: totalHits,
    cacheMisses: totalMisses,
    hitRate: requests.length > 0 ? Math.round((totalHits / requests.length) * 1000) / 10 : 0,
    workerAssignments,
    strategy: 'round-robin',
  };
}

/**
 * アフィニティ（コンシステントハッシュ）戦略でのキャッシュ統計。
 * 同一プレフィックスは同一ワーカーに集約される前提。
 *
 * @param {Request[]} requests - リクエスト一覧
 * @param {number} workerCount - ワーカー数
 * @returns {object} 統計情報
 */
export function simulateAffinity(requests, workerCount) {
  if (!Array.isArray(requests) || requests.length === 0) {
    return { totalRequests: 0, cacheHits: 0, cacheMisses: 0, hitRate: 0, workerAssignments: {} };
  }

  const workerNames = Array.from({ length: workerCount }, (_, i) => `worker-${i}`);
  const ring = createRing(workerNames);

  // プレフィックスグループごとに集計
  const groups = {};
  for (const req of requests) {
    if (!groups[req.prefix]) groups[req.prefix] = [];
    groups[req.prefix].push(req);
  }

  let totalHits = 0;
  let totalMisses = 0;
  const workerAssignments = {};

  for (const [prefix, group] of Object.entries(groups)) {
    const worker = routeRequest(ring, prefix);
    if (!workerAssignments[worker]) workerAssignments[worker] = { requests: 0, hits: 0, misses: 0 };
    // 同じプレフィックスは全て同じワーカーへ
    for (let i = 0; i < group.length; i++) {
      workerAssignments[worker].requests++;
      if (i === 0) {
        workerAssignments[worker].misses++;
        totalMisses++;
      } else {
        workerAssignments[worker].hits++;
        totalHits++;
      }
    }
  }

  return {
    totalRequests: requests.length,
    cacheHits: totalHits,
    cacheMisses: totalMisses,
    hitRate: requests.length > 0 ? Math.round((totalHits / requests.length) * 1000) / 10 : 0,
    workerAssignments,
    strategy: 'affinity',
  };
}

/**
 * ラウンドロビンとアフィニティを比較。
 *
 * @param {Request[]} requests - リクエスト一覧
 * @param {number} workerCount - ワーカー数
 * @returns {object} 比較レポート
 */
export function compareStrategies(requests, workerCount) {
  const rr = simulateRoundRobin(requests, workerCount);
  const aff = simulateAffinity(requests, workerCount);

  const hitRateDiff = aff.hitRate - rr.hitRate;
  const missDiff = rr.cacheMisses - aff.cacheMisses;

  return {
    workerCount,
    totalRequests: requests.length,
    uniquePrefixes: new Set(requests.map(r => r.prefix)).size,
    roundRobin: rr,
    affinity: aff,
    improvement: {
      hitRateGain: Math.round(hitRateDiff * 10) / 10,
      missReduction: missDiff,
    },
  };
}

// ───────── デモシナリオ ─────────

const DEMO_SCENARIOS = {
  'booth-proposal': {
    title: '展示会ブース提案生成（3テンプレート × 各20案件）',
    prefixes: [
      '展示会ブースデザイナー: 以下のガイドラインに従って提案を生成してください。\n- ブースサイズ: 標準小間（2.7m×6m）\n- 構造材: アルミフレーム\n- パネル高: 2.5mまで\n- 照明: LED(100W相当)×4基まで',
      '展示会ブースデザイナー: 以下のガイドラインに従って提案を生成してください。\n- ブースサイズ: 6m×6mコーナー\n- 構造材: システム部材\n- パネル高: 3.0mまで\n- 照明: LED(150W相当)×6基まで',
      '展示会ブースデザイナー: 以下のガイドラインに従って提案を生成してください。\n- ブースサイズ: 6m×9m島型\n- 構造材: アルミ+システムハイブリッド\n- パネル高: 3.5mまで\n- 照明: スポット+間接 組合せ',
    ],
    casesPerPrefix: 20,
    workerCount: 8,
  },
  'event-planning': {
    title: 'イベント企画（5テンプレート × 各10案件）',
    prefixes: [
      'イベント企画アシスタントです。展示会・商談会の企画立案を支援します。\n標準企画項目: 目的設定、ターゲット来場者、ブースサイズ、予算枠',
      'イベント企画アシスタントです。セミナー・講演会の企画立案を支援します。\n標準企画項目: テーマ、講師選定、会場種別、参加費設計',
      'イベント企画アシスタントです。ネットワーキングイベントの企画立案を支援します。\n標準企画項目: 参加者属性、交流形式、タイムライン、ケータリング',
      'イベント企画アシスタントです。オンラインイベントの企画立案を支援します。\n標準企画項目: 配信プラットフォーム、セッション構成、参加者管理',
      'イベント企画アシスタントです。表彰式・コンペ企画の立案を支援します。\n標準企画項目: 審査基準、ノミネート方式、表彰種別、会場演出',
    ],
    casesPerPrefix: 10,
    workerCount: 8,
  },
  'single-prefix': {
    title: '同一プレフィックス大量リクエスト',
    prefixes: [
      '同一の固定システムプロンプト。変更なし。この文字列は全リクエストで完全に一致します。',
    ],
    casesPerPrefix: 100,
    workerCount: 8,
  },
};

/**
 * デモシナリオを実行。
 *
 * @param {string} [scenarioName='booth-proposal'] - シナリオ名
 * @returns {object} デモ結果
 */
export function demo(scenarioName = 'booth-proposal') {
  const scenario = DEMO_SCENARIOS[scenarioName];
  if (!scenario) {
    throw new Error(`Unknown scenario: ${scenarioName}. Available: ${Object.keys(DEMO_SCENARIOS).join(', ')}`);
  }

  const requests = [];
  for (let pi = 0; pi < scenario.prefixes.length; pi++) {
    for (let ci = 0; ci < scenario.casesPerPrefix; ci++) {
      requests.push({
        id: `prefix-${pi}-case-${ci}`,
        prefix: scenario.prefixes[pi],
        staticLen: scenario.prefixes[pi].length,
        dynamicLen: 50 + Math.floor(Math.random() * 200),
      });
    }
  }

  const comparison = compareStrategies(requests, scenario.workerCount);

  // ハッシュの分散状態を表示用に計算
  const workerNames = Array.from({ length: scenario.workerCount }, (_, i) => `worker-${i}`);
  const ring = createRing(workerNames);
  const routeCounts = {};
  for (const w of workerNames) routeCounts[w] = 0;
  for (const prefix of scenario.prefixes) {
    const w = routeRequest(ring, prefix);
    routeCounts[w] = (routeCounts[w] || 0) + 1;
  }

  return {
    scenario: scenario.title,
    workerCount: scenario.workerCount,
    prefixes: scenario.prefixes.length,
    totalRequests: requests.length,
    ringEntries: ring.entries.length,
    prefixDistribution: routeCounts,
    comparison,
  };
}

/**
 * リング状態を人間可読な形で出力。
 */
export function ringStatus(ring) {
  if (!ring || !ring.entries) return { workerCount: 0, entries: [] };
  const byWorker = {};
  for (const e of ring.entries) {
    if (!byWorker[e.worker]) byWorker[e.worker] = { virtualNodes: 0, positions: [] };
    byWorker[e.worker].virtualNodes++;
    byWorker[e.worker].positions.push(e.position);
  }
  const entries = Object.entries(byWorker).map(([worker, info]) => ({
    worker,
    virtualNodes: info.virtualNodes,
    positionRange: [Math.min(...info.positions), Math.max(...info.positions)],
    coverage: Math.round((info.positions.length / ring.entries.length) * 1000) / 10,
  }));
  return { workerCount: ring.workers.length, totalEntries: ring.entries.length, entries };
}

// ───────── CLI ─────────

function printHelp() {
  console.log(`X-0098: プレフィックスアウェア・ルーティング — マルチワーカーキャッシュ効率最大化

使い方:
  node tools/x0098-prefix-router.mjs --demo [シナリオ名]
      デモ実行（booth-proposal, event-planning, single-prefix）
  node tools/x0098-prefix-router.mjs --route <プレフィックス> --workers N
      プレフィックスから担当ワーカーを表示
  node tools/x0098-prefix-router.mjs --ring --workers N
      コンシステントハッシュリングの状態を表示
  node tools/x0098-prefix-router.mjs --simulate <requests.json>
      JSONファイルのリクエスト一覧から統計を計算
  node tools/x0098-prefix-router.mjs --compare --workers N
      プレフィックス別リクエスト数からラウンドロビンとアフィニティを比較
  node tools/x0098-prefix-router.mjs --hash <プレフィックス>
      プレフィックスのハッシュ値を計算
  node tools/x0098-prefix-router.mjs --help
      このヘルプ

シナリオ:
  booth-proposal    展示会ブース提案（3テンプレート×20案件×8ワーカー）
  event-planning    イベント企画（5テンプレート×10案件×8ワーカー）
  single-prefix     同一プレフィックス大量（1テンプレート×100案件×8ワーカー）
`);
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.length === 0) { printHelp(); return; }

  // --hash <string>
  if (args.includes('--hash')) {
    const idx = args.indexOf('--hash');
    const prefix = idx + 1 < args.length ? args[idx + 1] : '';
    if (!prefix) { console.error('--hash requires a string argument'); process.exit(2); }
    const fnv = hashPrefix(prefix);
    const sha = hashPrefixSha256(prefix);
    console.log(JSON.stringify({ prefix, fnvHash: fnv, sha256Hash: sha, ringSize: RING_SIZE }, null, 2));
    return;
  }

  // --route <prefix> [--workers N]
  if (args.includes('--route')) {
    const idx = args.indexOf('--route');
    const prefix = idx + 1 < args.length ? args[idx + 1] : '';
    if (!prefix) { console.error('--route requires a string argument'); process.exit(2); }
    const workerIdx = args.indexOf('--workers');
    const workerCount = workerIdx >= 0 && workerIdx + 1 < args.length ? parseInt(args[workerIdx + 1], 10) || 8 : 8;
    const workerNames = Array.from({ length: workerCount }, (_, i) => `worker-${i}`);
    const ring = createRing(workerNames);
    const worker = routeRequest(ring, prefix);
    console.log(JSON.stringify({ prefix, workerCount, assignedWorker: worker }, null, 2));
    return;
  }

  // --ring [--workers N]
  if (args.includes('--ring')) {
    const workerIdx = args.indexOf('--workers');
    const workerCount = workerIdx >= 0 && workerIdx + 1 < args.length ? parseInt(args[workerIdx + 1], 10) || 8 : 8;
    const workerNames = Array.from({ length: workerCount }, (_, i) => `worker-${i}`);
    const ring = createRing(workerNames);
    const status = ringStatus(ring);
    console.log(JSON.stringify(status, null, 2));
    return;
  }

  // --simulate <file.json> [--workers N]
  if (args.includes('--simulate')) {
    const idx = args.indexOf('--simulate');
    const file = idx + 1 < args.length ? args[idx + 1] : '';
    if (!file) { console.error('--simulate requires a file path'); process.exit(2); }
    const workerIdx = args.indexOf('--workers');
    const workerCount = workerIdx >= 0 && workerIdx + 1 < args.length ? parseInt(args[workerIdx + 1], 10) || 8 : 8;
    const requests = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(requests)) { console.error('requests.json must be an array'); process.exit(2); }
    const comparison = compareStrategies(requests, workerCount);
    console.log(JSON.stringify(comparison, null, 2));
    return;
  }

  // --compare [--workers N]
  if (args.includes('--compare')) {
    const workerIdx = args.indexOf('--workers');
    const workerCount = workerIdx >= 0 && workerIdx + 1 < args.length ? parseInt(args[workerIdx + 1], 10) || 8 : 8;
    // 標準のテストケース
    const requests = [
      { id: 'a1', prefix: 'AAA' }, { id: 'a2', prefix: 'AAA' }, { id: 'a3', prefix: 'AAA' },
      { id: 'b1', prefix: 'BBB' }, { id: 'b2', prefix: 'BBB' },
      { id: 'c1', prefix: 'CCC' }, { id: 'c2', prefix: 'CCC' }, { id: 'c3', prefix: 'CCC' }, { id: 'c4', prefix: 'CCC' },
      { id: 'd1', prefix: 'DDD' },
      { id: 'e1', prefix: 'EEE' }, { id: 'e2', prefix: 'EEE' },
    ];
    const comparison = compareStrategies(requests, workerCount);
    console.log(JSON.stringify(comparison, null, 2));
    return;
  }

  // --demo [scenario]
  if (args.includes('--demo')) {
    const idx = args.indexOf('--demo');
    const scenario = idx + 1 < args.length && !args[idx + 1].startsWith('--') ? args[idx + 1] : 'booth-proposal';
    if (!DEMO_SCENARIOS[scenario]) {
      console.error(`Unknown scenario: ${scenario}. Available: ${Object.keys(DEMO_SCENARIOS).join(', ')}`);
      process.exit(2);
    }
    const result = demo(scenario);
    console.log(JSON.stringify(result, null, 2));

    // 人間可読なサマリも表示
    const c = result.comparison;
    console.log(`\n=== X-0098 シミュレーション結果: ${result.scenario} ===`);
    console.log(`ワーカー数: ${result.workerCount}`);
    console.log(`リクエスト総数: ${result.totalRequests}`);
    console.log(`ユニークプレフィックス: ${result.prefixes}`);
    console.log('');
    console.log(`【ラウンドロビン】ヒット率: ${c.roundRobin.hitRate}% (ヒット:${c.roundRobin.cacheHits}, ミス:${c.roundRobin.cacheMisses})`);
    console.log(`【アフィニティ】  ヒット率: ${c.affinity.hitRate}% (ヒット:${c.affinity.cacheHits}, ミス:${c.affinity.cacheMisses})`);
    console.log(`改善: ヒット率 +${c.improvement.hitRateGain}%p, ミス削減 ${c.improvement.missReduction}件`);
    console.log(`\nプレフィックスのワーカー分散:`);
    for (const [w, count] of Object.entries(result.prefixDistribution)) {
      console.log(`  ${w}: ${count}個のプレフィックス`);
    }
    return;
  }

  printHelp();
}

if (isEntry(import.meta.url)) {
  try { main(); } catch (err) { console.error('Error:', err.message); process.exit(1); }
}