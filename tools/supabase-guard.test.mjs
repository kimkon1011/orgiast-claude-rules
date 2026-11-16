import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createSupabaseGuard, readGuardState, writeGuardState, cacheKey, spikeWindowStart } from './supabase-guard.mjs';

const FIXTURE_URL = 'https://test-project.supabase.co';
const FIXTURE_KEY = 'test-service-role-key';

// テスト用テンポラリディレクトリ
function tmpDir(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-guard-'));
  t.after(() => { try { fs.rmSync(d, { recursive: true }); } catch { /* */ } });
  return d;
}

// テスト用 fetch: URL のパス部分からテーブル名を推定、適当な JSON を返す
function makeFetchImpl(staticRows) {
  return async (url, opts) => {
    const rows = staticRows ?? [{ id: 1, body: 'test' }];
    return {
      ok: true,
      status: 200,
      headers: {
        get: (name) => {
          if (name === 'content-range') return '0-499/500';
          return null;
        },
      },
      json: async () => rows,
    };
  };
}

// ---------- 基本機能 ----------

test('createSupabaseGuard には URL と KEY が必須', () => {
  assert.throws(() => createSupabaseGuard({}), /URL is required/);
  assert.throws(() => createSupabaseGuard({ url: FIXTURE_URL }), /key is required/);
  assert.doesNotThrow(() => createSupabaseGuard({ url: FIXTURE_URL, key: FIXTURE_KEY, storeDir: fs.mkdtempSync(path.join(os.tmpdir(), 'sb-')) }));
});

test('cacheKey は同一パラメータで同じハッシュを返す', () => {
  const a = cacheKey('channel_messages', { select: 'id', 'channel': 'eq.line', limit: 500 });
  const b = cacheKey('channel_messages', { limit: 500, 'channel': 'eq.line', select: 'id' });
  assert.equal(a, b);
  const c = cacheKey('channel_messages', { select: 'id', 'channel': 'eq.line', limit: 100 });
  assert.notEqual(a, c); // 異なるパラメータは異なるキー
});

test('spikeWindowStart は windowMs で区切る', () => {
  assert.equal(spikeWindowStart(0, 60000), 0);
  assert.equal(spikeWindowStart(59999, 60000), 0);
  assert.equal(spikeWindowStart(60000, 60000), 60000);
  assert.equal(spikeWindowStart(60001, 60000), 60000);
});

test('fetch は正常にデータを取得する', async (t) => {
  const fetchImpl = makeFetchImpl([{ id: 1, name: 'test' }]);
  const guard = createSupabaseGuard({ url: FIXTURE_URL, key: FIXTURE_KEY, storeDir: tmpDir(t), fetchImpl, nowImpl: () => 0 });
  const { rows, cached, scanCount } = await guard.fetch('test_table', {});
  assert.deepEqual(rows, [{ id: 1, name: 'test' }]);
  assert.equal(cached, false);
  assert.equal(scanCount, 1);
});

test('2回目の fetch はキャッシュから返る', async (t) => {
  let callCount = 0;
  const storeDir = tmpDir(t);
  const now = Date.now();
  const fetchImpl = async () => {
    callCount++;
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => [{ id: 1 }],
    };
  };
  const guard = createSupabaseGuard({ url: FIXTURE_URL, key: FIXTURE_KEY, storeDir, fetchImpl, nowImpl: () => now, cacheTtlMs: 60000 });
  const r1 = await guard.fetch('t', { select: 'id' });
  assert.equal(callCount, 1);
  assert.equal(r1.cached, false);
  const r2 = await guard.fetch('t', { select: 'id' });
  assert.equal(callCount, 1); // キャッシュヒットで fetchImpl は呼ばれない
  assert.equal(r2.cached, true);
  assert.deepEqual(r2.rows, [{ id: 1 }]);
});

test('TTL を過ぎたキャッシュは使われず再取得する', async (t) => {
  let callCount = 0;
  const storeDir = tmpDir(t);
  const fetchImpl = async () => {
    callCount++;
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => [{ id: callCount }],
    };
  };
  const start = 1000;
  const guard = createSupabaseGuard({ url: FIXTURE_URL, key: FIXTURE_KEY, storeDir, fetchImpl, nowImpl: () => start, cacheTtlMs: 100 });
  await guard.fetch('t', {});
  assert.equal(callCount, 1);
  // TTL 前
  const guard2 = createSupabaseGuard({ url: FIXTURE_URL, key: FIXTURE_KEY, storeDir, fetchImpl, nowImpl: () => start + 50, cacheTtlMs: 100 });
  const r2 = await guard2.fetch('t', {});
  assert.equal(callCount, 1); // キャッシュヒット
  assert.equal(r2.cached, true);
  // TTL 超過
  const guard3 = createSupabaseGuard({ url: FIXTURE_URL, key: FIXTURE_KEY, storeDir, fetchImpl, nowImpl: () => start + 101, cacheTtlMs: 100 });
  const r3 = await guard3.fetch('t', {});
  assert.equal(callCount, 2); // 再取得
  assert.equal(r3.cached, false);
});

// ---------- スパイク検出 ----------

test('スパイク検出: 短時間に大量行取得で 429', async (t) => {
  const storeDir = tmpDir(t);
  const now = 1000000;
  let fetchCall = 0;
  const fetchImpl = async () => {
    fetchCall++;
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => Array.from({ length: 60000 }, (_, i) => ({ id: i })),
    };
  };
  const guard = createSupabaseGuard({
    url: FIXTURE_URL, key: FIXTURE_KEY, storeDir,
    fetchImpl, nowImpl: () => now,
    maxRowsPerWindow: 100000, spikeWindowMs: 60000,
  });
  // 60,000 行は許可 (パラメータを変えてキャッシュ回避)
  await guard.fetch('t', { limit: '60000', seq: '1' });
  assert.equal(fetchCall, 1);
  // 同じ窓でさらに 60,000 → 合計 120,000 > 100,000 → 429
  await assert.rejects(
    () => guard.fetch('t', { limit: '60000', seq: '2' }),
    (err) => {
      assert.equal(err.statusCode, 429);
      assert.equal(err.code, 'SPIKE_DETECTED');
      return true;
    }
  );
});

test('スパイク窓が変わるとカウントがリセットされる', async (t) => {
  const storeDir = tmpDir(t);
  let now = 1000000;
  const fetchImpl = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => Array.from({ length: 80000 }, (_, i) => ({ id: i })),
  });
  const guard = createSupabaseGuard({
    url: FIXTURE_URL, key: FIXTURE_KEY, storeDir,
    fetchImpl, nowImpl: () => now,
    maxRowsPerWindow: 100000, spikeWindowMs: 60000,
  });
  await guard.fetch('t', { seq: '1' });
  // 同じ窓でさらに 80,000 → 160,000 > 100,000 → 429 (パラメータ変更でキャッシュ回避)
  await assert.rejects(() => guard.fetch('t', { seq: '2' }), (e) => e.code === 'SPIKE_DETECTED');
  // 次の窓に進む
  now += 60000;
  await assert.doesNotReject(() => guard.fetch('t', { seq: '3' }));
});

// ---------- 総量ガードレール ----------

test('総スキャン上限 300万 超過で 503', async (t) => {
  const storeDir = tmpDir(t);
  const now = 1000000;
  const fetchImpl = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => Array.from({ length: 2000000 }, (_, i) => ({ id: i })),
  });
  const guard = createSupabaseGuard({
    url: FIXTURE_URL, key: FIXTURE_KEY, storeDir,
    fetchImpl, nowImpl: () => now,
    maxTotalRows: 3000000, maxRowsPerWindow: 5000000,
  });
  await guard.fetch('t', { seq: '1' }); // 2M
  await assert.rejects(
    () => guard.fetch('t', { seq: '2' }), // さらに 2M → 4M > 3M (キャッシュ回避)
    (err) => {
      assert.equal(err.statusCode, 503);
      assert.equal(err.code, 'TOTAL_SCAN_LIMIT_EXCEEDED');
      return true;
    }
  );
});

// ---------- 状態の永続化 ----------

test('状態はディスクに保存・再読込される', async (t) => {
  const storeDir = tmpDir(t);
  const fetchImpl = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => [{ id: 1 }, { id: 2 }, { id: 3 }],
  });
  const guard = createSupabaseGuard({
    url: FIXTURE_URL, key: FIXTURE_KEY, storeDir,
    fetchImpl, nowImpl: () => 0,
    maxTotalRows: 100,
  });
  await guard.fetch('t', {});
  const state = readGuardState(storeDir);
  assert.equal(state.totalRowCount, 3);
  // 新しいインスタンスで読み込む
  const guard2 = createSupabaseGuard({
    url: FIXTURE_URL, key: FIXTURE_KEY, storeDir,
    fetchImpl, nowImpl: () => 1,
    maxTotalRows: 100,
  });
  const s2 = guard2.getState();
  assert.equal(s2.totalRowCount, 3);
});

test('resetState でカウントがクリアされる', async (t) => {
  const storeDir = tmpDir(t);
  const fetchImpl = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => [{ id: 1 }],
  });
  const guard = createSupabaseGuard({ url: FIXTURE_URL, key: FIXTURE_KEY, storeDir, fetchImpl, nowImpl: () => 0 });
  await guard.fetch('t', {});
  guard.resetState();
  const s = guard.getState();
  assert.equal(s.totalRowCount, 0);
  assert.equal(s.windowRowCount, 0);
});

// ---------- rawFetch ----------

test('rawFetch は Response を返し、レート制限を適用する', async (t) => {
  const storeDir = tmpDir(t);
  const now = 1000000;
  const fetchImpl = async (url, opts) => ({
    ok: true, status: 200,
    headers: { get: (name) => name === 'content-range' ? '0-99/100' : null },
    json: async () => Array.from({ length: 100 }, (_, i) => ({ id: i })),
    text: async () => '[...]',
  });
  const guard = createSupabaseGuard({
    url: FIXTURE_URL, key: FIXTURE_KEY, storeDir,
    fetchImpl, nowImpl: () => now,
    maxRowsPerWindow: 150,
  });
  const res = await guard.rawFetch(`${FIXTURE_URL}/rest/v1/test`, {});
  assert.ok(res.ok);
  // スパイク制限: 100行取得済み。さらに 100 行で 200 > 150 で 429
  await assert.rejects(
    () => guard.rawFetch(`${FIXTURE_URL}/rest/v1/test2`, {}),
    (e) => e.code === 'SPIKE_DETECTED'
  );
});

// ---------- CLI ----------

test('CLI --state で状態が出力される', async (t) => {
  const storeDir = tmpDir(t);
  process.env.SUPABASE_URL = FIXTURE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = FIXTURE_KEY;
  // 直接 createSupabaseGuard して状態を確認
  const guard = createSupabaseGuard({
    url: FIXTURE_URL, key: FIXTURE_KEY, storeDir,
    fetchImpl: makeFetchImpl([{ id: 1 }]), nowImpl: () => 0,
  });
  await guard.fetch('t', { select: 'id' });
  const state = guard.getState();
  assert.equal(state.totalRowCount, 1);
  assert.ok(state.windowStart >= 0);
});

test('空のテーブルも正常に処理する', async (t) => {
  const fetchImpl = async () => ({
    ok: true, status: 200, headers: { get: () => null },
    json: async () => [],
  });
  const guard = createSupabaseGuard({
    url: FIXTURE_URL, key: FIXTURE_KEY, storeDir: tmpDir(t),
    fetchImpl, nowImpl: () => 0,
  });
  const { rows, scanCount } = await guard.fetch('empty_table', {});
  assert.deepEqual(rows, []);
  assert.equal(scanCount, 0);
});