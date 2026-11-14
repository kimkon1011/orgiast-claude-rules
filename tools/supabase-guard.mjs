#!/usr/bin/env node
// tools/supabase-guard.mjs — X-0047: DBアクセスをキャッシュと制限で抑制
//
// Supabase REST API 呼出をラップし、以下を追加:
//   - ファイルキャッシュ (同じクエリの再取得を回避)
//   - スキャン件数スパイク検出 (短時間に大量取得 → 429 エラー)
//   - 総スキャン件数ガードレール (300万件超で停止)
//
// 使い方:
//   import { createSupabaseGuard } from './supabase-guard.mjs';
//   const client = createSupabaseGuard({ url: secrets.SUPABASE_URL, key: secrets.SUPABASE_SERVICE_ROLE_KEY });
//   const { rows, cached, scanCount } = await client.fetch('channel_messages', {
//     select: 'id,body', channel: 'eq.line', limit: 500,
//   });

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { isEntry } from './is-entry.mjs';

// ---------- 既定値 ----------

const DEFAULT_CACHE_DIR = path.join(os.homedir(), '.claude', 'supabase-guard-cache');
const DEFAULT_CACHE_TTL_MS = 60_000;        // キャッシュ有効期限 (1分)
const DEFAULT_SPIKE_WINDOW_MS = 60_000;      // スパイク検出窓 (1分)
const DEFAULT_MAX_ROWS_PER_WINDOW = 100_000; // 1分間の最大取得行数 (スパイク閾値)
const DEFAULT_MAX_TOTAL_ROWS = 3_000_000;    // 総スキャン数制限 (300万)
const GUARD_STATE_FILE = 'state.json';
const CACHE_INDEX_FILE = 'cache-index.json';

// ---------- 状態ファイル ----------

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* OK */ }
}

/** 永続化されたガード状態を読む (windowStart, windowRowCount, totalRowCount)。安全に読めなければ {}。 */
export function readGuardState(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, GUARD_STATE_FILE), 'utf8'));
  } catch {
    return {};
  }
}

/** ガード状態を永続化する。 */
export function writeGuardState(dir, state) {
  ensureDir(dir);
  const tmp = path.join(dir, `.${GUARD_STATE_FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n');
  fs.renameSync(tmp, path.join(dir, GUARD_STATE_FILE));
}

/** キャッシュ索引を読む。 */
function readCacheIndex(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, CACHE_INDEX_FILE), 'utf8'));
  } catch {
    return { version: 1, entries: {} };
  }
}

/** キャッシュ索引を書く。 */
function writeCacheIndex(dir, index) {
  ensureDir(dir);
  const tmp = path.join(dir, `.${CACHE_INDEX_FILE}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(index, null, 2) + '\n');
  fs.renameSync(tmp, path.join(dir, CACHE_INDEX_FILE));
}

// ---------- クエリハッシュ ----------

/** URL とクエリパラメータ(オブジェクト)から一意のキャッシュキー(sha256 hex)を計算する。 */
export function cacheKey(table, params) {
  const input = `${table}|${JSON.stringify(params, Object.keys(params).sort())}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

/** 現在のスパイク窓の開始時刻 (ms 精度、windowMs で区切る)。 */
export function spikeWindowStart(now, windowMs) {
  return Math.floor(now / windowMs) * windowMs;
}

// ---------- ガードクライアント生成 ----------

/**
 * Supabase REST API 用のガード付きクライアントを作成する。
 *
 * @param {object} opts
 * @param {string} opts.url       Supabase URL (https://xxx.supabase.co)
 * @param {string} opts.key       Supabase service_role key
 * @param {string} [opts.storeDir]  状態永続化先 (既定: ~/.claude/supabase-guard-cache/_<project-ref>)
 * @param {number} [opts.cacheTtlMs]       キャッシュTTL ms (既定: 60000)
 * @param {number} [opts.spikeWindowMs]    スパイク検出窓 ms (既定: 60000)
 * @param {number} [opts.maxRowsPerWindow] 1窓あたり最大行数 (既定: 100000)
 * @param {number} [opts.maxTotalRows]     総スキャン上限 (既定: 3000000)
 * @param {function} [opts.fetchImpl]      テスト用 fetch 差替え
 * @param {function} [opts.nowImpl]        テスト用時刻
 */
export function createSupabaseGuard(opts = {}) {
  const {
    url,
    key,
    storeDir: storeDirOpt,
    cacheTtlMs = DEFAULT_CACHE_TTL_MS,
    spikeWindowMs = DEFAULT_SPIKE_WINDOW_MS,
    maxRowsPerWindow = DEFAULT_MAX_ROWS_PER_WINDOW,
    maxTotalRows = DEFAULT_MAX_TOTAL_ROWS,
    fetchImpl = globalThis.fetch,
    nowImpl = Date.now,
  } = opts;

  if (!url) throw new Error('Supabase URL is required');
  if (!key) throw new Error('Supabase service role key is required');

  // プロジェクト固有のストアディレクトリ
  const projectRef = (url.match(/https:\/\/([^.]+)\.supabase\.co/) || [])[1] || 'unknown';
  const storeDir = storeDirOpt || path.join(DEFAULT_CACHE_DIR, projectRef);

  // 永続状態をロード
  const persisted = readGuardState(storeDir);
  let state = {
    windowStart: persisted.windowStart ?? 0,
    windowRowCount: persisted.windowRowCount ?? 0,
    totalRowCount: persisted.totalRowCount ?? 0,
  };

  function persist() {
    writeGuardState(storeDir, state);
  }

  // 現在の窓にリセット
  function refreshWindowIfNeeded(now) {
    const currentWindow = spikeWindowStart(now, spikeWindowMs);
    if (currentWindow !== state.windowStart) {
      state.windowStart = currentWindow;
      state.windowRowCount = 0;
      persist();
    }
  }

  /**
   * スパイク制限と総量制限をチェックする。
   * 制限超過時は Error を throw (statusCode プロパティ付き)。
   */
  function checkLimits(estimatedRows, now) {
    refreshWindowIfNeeded(now);

    if (state.totalRowCount + estimatedRows > maxTotalRows) {
      const err = new Error(
        `Supabase 総スキャン上限超過: ${state.totalRowCount} + ${estimatedRows} > ${maxTotalRows}`
      );
      err.statusCode = 503;
      err.code = 'TOTAL_SCAN_LIMIT_EXCEEDED';
      throw err;
    }

    if (state.windowRowCount + estimatedRows > maxRowsPerWindow) {
      const err = new Error(
        `Supabase スキャンスパイク検出: ${state.windowRowCount} + ${estimatedRows} > ${maxRowsPerWindow} (窓 ${spikeWindowMs}ms)`
      );
      err.statusCode = 429;
      err.code = 'SPIKE_DETECTED';
      err.retryAfterMs = state.windowStart + spikeWindowMs - now;
      throw err;
    }
  }

  /** 取得した行数を状態に加算する。 */
  function recordScan(rowsCount, now) {
    refreshWindowIfNeeded(now);
    state.windowRowCount += rowsCount;
    state.totalRowCount += rowsCount;
    persist();
  }

  /** レスポンスの JSON 配列長を行数としてカウントする。 */
  function countRows(json) {
    return Array.isArray(json) ? json.length : (json && typeof json === 'object' ? 1 : 0);
  }

  // ---------- キャッシュ ----------

  function readCache(hash) {
    const index = readCacheIndex(storeDir);
    const entry = index.entries[hash];
    if (!entry) return null;
    const age = nowImpl() - entry.cachedAt;
    if (age > cacheTtlMs) return null; // TTL 期限切れ
    try {
      const data = fs.readFileSync(path.join(storeDir, 'cache', `${hash}.json`), 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  function writeCache(hash, data) {
    const cacheDir = path.join(storeDir, 'cache');
    ensureDir(cacheDir);
    const tmp = path.join(cacheDir, `.${hash}.json.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, path.join(cacheDir, `${hash}.json`));
    const index = readCacheIndex(storeDir);
    index.entries[hash] = { cachedAt: nowImpl(), hash };
    // 古いキャッシュエントリを削除 (1000件を超えたら古いものから削除)
    const entries = Object.entries(index.entries);
    if (entries.length > 1000) {
      entries.sort((a, b) => a[1].cachedAt - b[1].cachedAt);
      for (let i = 0; i < entries.length - 800; i++) {
        const [oldHash] = entries[i];
        delete index.entries[oldHash];
        try { fs.unlinkSync(path.join(cacheDir, `${oldHash}.json`)); } catch { /* OK */ }
      }
    }
    writeCacheIndex(storeDir, index);
  }

  // ---------- 公開インタフェース ----------

  /**
   * Supabase REST API にクエリを投げ、キャッシュ・レート制限を適用して結果を返す。
   * GET リクエストは自動キャッシュされる。
   *
   * @param {string} table    テーブル名
   * @param {object} params   クエリパラメータ (例: { select: 'id,body', 'channel': 'eq.line', 'limit': 500 })
   * @param {object} [fetchOpts]  fetch に渡す追加オプション (signal, headers 等)
   * @returns {{ rows: object[], cached: boolean, scanCount: number, response: Response }}
   */
  async function fetch(table, params = {}, fetchOpts = {}) {
    const hash = cacheKey(table, params);
    const isGet = !fetchOpts.method || fetchOpts.method === 'GET';

    // GET の場合はキャッシュを先に見る
    if (isGet) {
      const cached = readCache(hash);
      if (cached) {
        const rows = Array.isArray(cached) ? cached : (cached.rows || [cached]);
        return { rows, cached: true, scanCount: 0, response: null };
      }
    }

    // URL を構築
    const qs = Object.entries(params)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const requestUrl = `${url}/rest/v1/${table}${qs ? `?${qs}` : ''}`;

    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      ...fetchOpts.headers,
    };

    // 制限チェック (非GETはスキャンとしてカウントしない)
    if (isGet) {
      // まず最小の見積もりでチェック (実際の行数に応じて後で調整)
      checkLimits(1, nowImpl());
    }

    const response = await fetchImpl(requestUrl, { ...fetchOpts, headers });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw Object.assign(new Error(`Supabase HTTP ${response.status}: ${body.slice(0, 200)}`), {
        statusCode: response.status,
        response,
      });
    }

    const json = await response.json();
    const rows = Array.isArray(json) ? json : (json && typeof json.rows ? json.rows : [json]);
    const scanCount = countRows(json);

    // 実際の行数で再チェック (スパイク時はここで throw)
    if (isGet && scanCount > 0) {
      checkLimits(scanCount, nowImpl());
      recordScan(scanCount, nowImpl());
    }

    // GET のレスポンスをキャッシュ
    if (isGet && scanCount > 0) {
      writeCache(hash, json);
    }

    return { rows, cached: false, scanCount, response };
  }

  /**
   * 生の URL で Supabase REST API にアクセスする (既存コードとの互換用)。
   * レート制限・スキャン追跡は適用されるが、キャッシュは使われない。
   * Response オブジェクトを返す (既存の fetchImpl 互換)。
   *
   * @param {string} requestUrl  完全な URL
   * @param {object} [fetchOpts]
   * @returns {Promise<Response>}
   */
  async function rawFetch(requestUrl, fetchOpts = {}) {
    const headers = {
      apikey: key,
      Authorization: `Bearer ${key}`,
      ...fetchOpts.headers,
    };

    const isGet = !fetchOpts.method || fetchOpts.method === 'GET';
    const estimatedRows = 1;
    if (isGet) checkLimits(estimatedRows, nowImpl());

    const response = await fetchImpl(requestUrl, { ...fetchOpts, headers });

    // 成功した GET は Content-Range から行数を推定して記録
    if (isGet && response.ok) {
      const cr = response.headers.get('content-range');
      let rowsCount = 0;
      if (cr) {
        // "0-499/1234" → last row + 1 が行数範囲外の時は "/0" の可能性も
        const match = cr.match(/^(\d+)-(\d+)\/(\d+)$/);
        if (match) {
          rowsCount = Number(match[2]) - Number(match[1]) + 1;
        }
      }
      if (rowsCount > 0) {
        checkLimits(rowsCount, nowImpl());
        recordScan(rowsCount, nowImpl());
      }
    }

    return response;
  }

  /** ガード状態の現在値を取得する (テスト・診断用)。 */
  function getState() {
    return { ...state, now: nowImpl(), windowStart: spikeWindowStart(nowImpl(), spikeWindowMs) };
  }

  /** ガード状態をリセットする (テスト用)。 */
  function resetState() {
    state = { windowStart: 0, windowRowCount: 0, totalRowCount: 0 };
    persist();
  }

  return {
    fetch,
    rawFetch,
    getState,
    resetState,
    url,
    key,
    storeDir,
  };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const o = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--url') o.url = argv[++i];
    else if (a === '--key') o.key = argv[++i];
    else if (a === '--state') o.getState = true;
    else if (a === '--reset') o.reset = true;
    else if (a === '--cache-stats') o.cacheStats = true;
    else if (a === '--clear-cache') o.clearCache = true;
    else if (a.startsWith('--store-dir=')) o.storeDir = a.split('=')[1];
  }
  return o;
}

async function main(argv) {
  const opts = parseArgs(argv);
  if (!opts.url) {
    console.error('使い方: node tools/supabase-guard.mjs --url <URL> --key <KEY> [--state | --reset | --cache-stats | --clear-cache]');
    process.exit(1);
  }

  const guard = createSupabaseGuard({ url: opts.url, key: opts.key, storeDir: opts.storeDir });

  if (opts.getState) {
    console.log(JSON.stringify(guard.getState(), null, 2));
  } else if (opts.reset) {
    guard.resetState();
    console.log('reset');
  } else if (opts.cacheStats) {
    const dir = guard.storeDir;
    const index = readCacheIndex(dir);
    const entryCount = Object.keys(index.entries).length;
    const cacheDir = path.join(dir, 'cache');
    let diskBytes = 0;
    try {
      for (const f of fs.readdirSync(cacheDir)) {
        if (f.endsWith('.json')) diskBytes += fs.statSync(path.join(cacheDir, f)).size;
      }
    } catch { /* OK */ }
    console.log(JSON.stringify({ entries: entryCount, diskBytes, ttlMs: DEFAULT_CACHE_TTL_MS }, null, 2));
  } else if (opts.clearCache) {
    const dir = guard.storeDir;
    const cacheDir = path.join(dir, 'cache');
    try {
      for (const f of fs.readdirSync(cacheDir)) {
        if (f.endsWith('.json')) fs.unlinkSync(path.join(cacheDir, f));
      }
    } catch { /* OK */ }
    writeCacheIndex(dir, { version: 1, entries: {} });
    console.log('cache cleared');
  }
}

if (isEntry(import.meta.url)) {
  main(process.argv).catch(e => { console.error(e.message); process.exit(1); });
}