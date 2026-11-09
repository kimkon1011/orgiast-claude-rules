import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CACHE_TTL_SEC,
  PING_INTERVAL_SEC,
  cacheStatus,
  cacheStatusLine,
  ping,
  schedulePing,
  cancelPing,
  readState,
  writeState,
  statePath,
  stateDir,
} from './cache-monitor.mjs';

function makeHome() {
  const dir = fs.mkdtempSync('cache-monitor-test-');
  fs.mkdirSync(path.join(dir, '.claude', 'cache-monitor'), { recursive: true });
  return dir;
}

function writeStateFor(home, data) {
  writeState(data, home);
}

test('cacheTtl calculation from lastActivityAt', () => {
  const home = makeHome();
  try {
    const now = Date.now();
    writeStateFor(home, { lastActivityAt: new Date(now - 120 * 1000).toISOString() }); // 120秒前
    const status = cacheStatus({ home, now });
    assert.equal(status.cacheExpired, false);
    assert.ok(status.cacheTtlSec <= CACHE_TTL_SEC - 120 + 1); // allow 1s skew
    assert.ok(status.cacheTtlSec >= CACHE_TTL_SEC - 120 - 1);
    assert.equal(typeof status.memoryMb, 'number');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cache expired detection (>=300s)', () => {
  const home = makeHome();
  try {
    const now = Date.now();
    writeStateFor(home, { lastActivityAt: new Date(now - 301 * 1000).toISOString() }); // 301秒前
    const status = cacheStatus({ home, now });
    assert.equal(status.cacheExpired, true);
    assert.equal(status.cacheTtlSec, 0);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('schedulePing returns datetime ~25min in future', () => {
  const home = makeHome();
  try {
    const now = Date.now();
    const result = schedulePing({ home, now });
    assert.ok(typeof result.at === 'string');
    const scheduled = Date.parse(result.at);
    const diff = (scheduled - now) / 1000;
    assert.ok(Math.abs(diff - PING_INTERVAL_SEC) < 2); // 1500±2秒
    // state に保存されているか
    const state = readState(home);
    assert.equal(state.pingScheduledAt, result.at);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('ping updates lastActivityAt', () => {
  const home = makeHome();
  try {
    const now = Date.now();
    writeStateFor(home, { lastActivityAt: new Date(now - 600 * 1000).toISOString() });
    const result = ping({ home, now });
    assert.deepEqual(result, {});
    const state = readState(home);
    assert.equal(state.lastActivityAt, new Date(now).toISOString());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cancelPing clears pingScheduledAt', () => {
  const home = makeHome();
  try {
    const now = Date.now();
    writeStateFor(home, { pingScheduledAt: new Date(now + 300 * 1000).toISOString() });
    const result = cancelPing({ home, now });
    assert.deepEqual(result, { cancel: true });
    const state = readState(home);
    assert.equal(state.pingScheduledAt, null);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('graceful behavior without state file', () => {
  const home = makeHome();
  try {
    // 状態ファイルが無い状態
    const status = cacheStatus({ home });
    assert.equal(status.cacheTtlSec, null);
    assert.equal(status.cacheExpired, true);
    assert.equal(typeof status.memoryMb, 'number');

    const line = cacheStatusLine({ home });
    assert.ok(line.includes('TTL:--'));
    assert.ok(line.includes('🅿--'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('cacheStatusLine formats correctly', () => {
  const home = makeHome();
  try {
    const now = Date.now();
    writeStateFor(home, {
      lastActivityAt: new Date(now - 30 * 1000).toISOString(),
      pingScheduledAt: new Date(now + 1200 * 1000).toISOString(),
    });
    const line = cacheStatusLine({ home, now });
    assert.ok(line.includes('TTL:4m')); // 300-30=270s → 4m30s
    assert.ok(line.includes('🅿'));
    assert.ok(line.includes('📊'));

    // expired
    writeStateFor(home, {
      lastActivityAt: new Date(now - 301 * 1000).toISOString(),
      pingScheduledAt: null,
    });
    const expired = cacheStatusLine({ home, now });
    assert.ok(expired.includes('expired'));
    assert.ok(expired.includes('🅿--'));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('stateDir and statePath resolve correctly', () => {
  const home = makeHome();
  try {
    const dir = stateDir(home);
    assert.ok(dir.endsWith(path.join('.claude', 'cache-monitor')));
    const sp = statePath(home);
    assert.ok(sp.endsWith(path.join('.claude', 'cache-monitor', 'state.json')));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});