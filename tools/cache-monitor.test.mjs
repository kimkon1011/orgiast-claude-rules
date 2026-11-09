import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  cacheStatus,
  cacheStatusLine,
  ping,
  schedulePing,
  cancelPing,
  readState,
  writeState,
  statePath,
  CACHE_TTL_SEC,
  PING_INTERVAL_SEC,
  stateDir,
} from './cache-monitor.mjs';

// テスト用に隔離された statePath を使う
const testStateDir = path.join(os.tmpdir(), 'cache-monitor-test-' + Date.now());
const testStatePath = path.join(testStateDir, 'state.json');

function withTestState(fn) {
  return async (t) => {
    // 元の関数を退避
    const origReadState = readState;
    const origWriteState = writeState;
    const origStatePath = statePath;
    const origStateDir = stateDir;

    // モジュールの参照を直接書き換え (export されているので上書き)
    // テスト用の隔離ディレクトリを使うため、setup でベタ書き
    // → 代わりに手動で state ファイルを用意する方式
    await fn(t);
  };
}

// clean up
process.on('exit', () => {
  try {
    fs.rmSync(testStateDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

function setupTestState(overrides = {}) {
  try {
    fs.mkdirSync(testStateDir, { recursive: true });
  } catch { /* ok */ }
  const defaultState = {
    lastActivityAt: null,
    pingScheduledAt: null,
    pingIntervalSec: 1500,
  };
  fs.writeFileSync(testStatePath, JSON.stringify({ ...defaultState, ...overrides }, null, 2), 'utf-8');
}

// テスト用にモジュールの read/write を一時的に差し替え
function withTempState(overrides, fn) {
  // state ファイルを直接配置し、cacheStatus は readState 経由で読む
  setupTestState(overrides);
  // ここで statePath を使わずに手動で読むテストでも良いが、
  // モジュール内の statePath 定数は変えられないので、
  // readState が ~/.claude/cache-monitor/state.json を見る。
  // テスト環境では事前にそちらを設置 or cleanup する。
  // → 実運用のパスを使うので、テスト実行後は cleanup する。
  fn();
}

/**
 * テストの度に隔離 state を ~/.claude/cache-monitor/state.json に書き込む。
 * テスト後に元の state を復元する。
 */
let originalStateBackup = null;

function backupOriginalState() {
  try {
    if (fs.existsSync(statePath)) {
      originalStateBackup = fs.readFileSync(statePath, 'utf-8');
    } else {
      originalStateBackup = null;
    }
  } catch {
    originalStateBackup = null;
  }
}

function restoreOriginalState() {
  try {
    if (originalStateBackup !== null) {
      fs.writeFileSync(statePath, originalStateBackup, 'utf-8');
    } else if (fs.existsSync(statePath)) {
      fs.rmSync(statePath, { force: true });
    }
  } catch {
    // fail-open
  }
}

function withIsolatedState(overrides) {
  restoreOriginalState(); // 前回のテストの影響を消す
  const defaultState = {
    lastActivityAt: null,
    pingScheduledAt: null,
    pingIntervalSec: 1500,
  };
  try {
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
  } catch { /* fail-open */ }
  fs.writeFileSync(statePath, JSON.stringify({ ...defaultState, ...overrides }, null, 2), 'utf-8');
}

// ----------------------------------------------------------------
// テスト1: cacheTtl 計算（最終アクティビティから経過時間で TTL が正しく計算される）
// ----------------------------------------------------------------
test('cacheTtl calculation from lastActivityAt', () => {
  const past = new Date(Date.now() - 60000).toISOString(); // 60秒前
  withIsolatedState({ lastActivityAt: past });
  const status = cacheStatus();
  // 300秒 - 60秒 = 240秒程度（多少の誤差）
  assert.ok(status.cacheTtlSec >= 230 && status.cacheTtlSec <= 250,
    `Expected TTL ~240s, got ${status.cacheTtlSec}s`);
  assert.equal(status.cacheExpired, false);
  restoreOriginalState();
});

// ----------------------------------------------------------------
// テスト2: キャッシュ期限切れ検出
// ----------------------------------------------------------------
test('cache expired detection (>=300s)', () => {
  const past = new Date(Date.now() - CACHE_TTL_SEC * 1000 - 1000).toISOString(); // 301秒以上前
  withIsolatedState({ lastActivityAt: past });
  const status = cacheStatus();
  assert.equal(status.cacheTtlSec, 0, 'TTL should be 0 when expired');
  assert.equal(status.cacheExpired, true);
  restoreOriginalState();
});

// ----------------------------------------------------------------
// テスト3: ping スケジュール（25分後の時刻が正しく計算される）
// ----------------------------------------------------------------
test('schedulePing returns datetime ~25min in future', () => {
  withIsolatedState({});
  const before = Date.now();
  const result = schedulePing();
  const after = Date.now();
  const pingTime = new Date(result.at).getTime();
  // 25分前後
  assert.ok(pingTime >= before + PING_INTERVAL_SEC * 1000 - 2000,
    `pingTime ${pingTime} should be >= ${before + PING_INTERVAL_SEC * 1000 - 2000}`);
  assert.ok(pingTime <= after + PING_INTERVAL_SEC * 1000 + 2000,
    `pingTime ${pingTime} should be <= ${after + PING_INTERVAL_SEC * 1000 + 2000}`);
  // state に保存されたか確認
  const state = readState();
  assert.equal(state.pingScheduledAt, result.at);
  restoreOriginalState();
});

// ----------------------------------------------------------------
// テスト4: ping の実行で lastActivityAt が更新される
// ----------------------------------------------------------------
test('ping updates lastActivityAt', () => {
  const past = new Date(Date.now() - 120000).toISOString(); // 120秒前
  withIsolatedState({ lastActivityAt: past });
  const beforePing = new Date();
  ping();
  const state = readState();
  assert.ok(state.lastActivityAt !== null, 'lastActivityAt should not be null after ping');
  const pingTime = new Date(state.lastActivityAt).getTime();
  assert.ok(pingTime >= beforePing.getTime() - 2000,
    `pingTime ${pingTime} should be >= ${beforePing.getTime() - 2000}`);
  assert.ok(pingTime <= Date.now() + 1000,
    `pingTime ${pingTime} should be <= now`);
  restoreOriginalState();
});

// ----------------------------------------------------------------
// テスト5: cancel-ping で pingScheduledAt が null になる
// ----------------------------------------------------------------
test('cancelPing clears pingScheduledAt', () => {
  withIsolatedState({ pingScheduledAt: new Date(Date.now() + 60000).toISOString() });
  const result = cancelPing();
  assert.equal(result.cancel, true);
  const state = readState();
  assert.equal(state.pingScheduledAt, null);
  restoreOriginalState();
});

// ----------------------------------------------------------------
// テスト6: 状態ファイルが無い場合の graceful 動作
// ----------------------------------------------------------------
test('graceful behavior without state file', () => {
  // state ファイルを削除
  try {
    if (fs.existsSync(statePath)) fs.rmSync(statePath, { force: true });
  } catch { /* ok */ }
  // cacheStatus がエラーを投げない
  const status = cacheStatus();
  assert.equal(status.cacheTtlSec, null);
  assert.equal(status.cacheExpired, true);
  assert.ok(typeof status.memoryMb === 'number');
  // cacheStatusLine もエラーを投げない
  const line = cacheStatusLine();
  assert.ok(typeof line === 'string');
  assert.ok(line.length > 0);
  // ping もエラーを投げない（fail-open）
  const result = ping();
  assert.deepEqual(result, {});
  restoreOriginalState();
});