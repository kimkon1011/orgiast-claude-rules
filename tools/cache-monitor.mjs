#!/usr/bin/env node
// X-0017: キャッシュ監視で20倍コスト増を防止
// Claude Code のプロンプトキャッシュ残り時間を監視し、キャッシュ維持用pingを予約する
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

export const CACHE_TTL_SEC = 300; // 5分（Anthropic プロンプトキャッシュTTL）
export const PING_INTERVAL_SEC = 1500; // 25分

export const stateDir = path.join(os.homedir(), '.claude', 'cache-monitor');
export const statePath = path.join(stateDir, 'state.json');

function ensureStateDir() {
  try {
    if (!fs.existsSync(stateDir)) {
      fs.mkdirSync(stateDir, { recursive: true });
    }
  } catch {
    // fail-open
  }
}

// デフォルト状態
const defaultState = () => ({
  lastActivityAt: null,
  pingScheduledAt: null,
  pingIntervalSec: PING_INTERVAL_SEC,
});

export function readState() {
  try {
    ensureStateDir();
    if (!fs.existsSync(statePath)) return defaultState();
    const raw = fs.readFileSync(statePath, 'utf-8');
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

export function writeState(state) {
  try {
    ensureStateDir();
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch {
    // fail-open
  }
}

/** キャッシュ状態を返す */
export function cacheStatus() {
  const state = readState();
  const now = Date.now();

  let cacheTtlSec = null;
  let cacheExpired = true;

  if (state.lastActivityAt) {
    const elapsed = (now - new Date(state.lastActivityAt).getTime()) / 1000;
    cacheTtlSec = Math.max(0, CACHE_TTL_SEC - Math.floor(elapsed));
    cacheExpired = cacheTtlSec <= 0;
  }

  const subscription = (() => {
    try {
      const claudeJsonPath = path.join(os.homedir(), '.claude', 'claude.json');
      if (!fs.existsSync(claudeJsonPath)) return 'unknown';
      const claudeJson = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf-8'));
      return claudeJson.subscription || 'unknown';
    } catch {
      return 'unknown';
    }
  })();

  let memoryMb = 0;
  try {
    const mem = process.memoryUsage();
    memoryMb = Math.round(mem.rss / 1024 / 1024);
  } catch {
    // fail-open
  }

  let nextPingAt = null;
  if (state.pingScheduledAt) {
    nextPingAt = state.pingScheduledAt;
  }

  return {
    cacheTtlSec,
    cacheExpired,
    subscription,
    memoryMb,
    ping: {
      nextAt: nextPingAt,
      intervalSec: state.pingIntervalSec || PING_INTERVAL_SEC,
    },
    timestamp: new Date().toISOString(),
  };
}

/** ステータスバー用1行を返す */
export function cacheStatusLine() {
  const s = cacheStatus();
  const parts = [];

  // キャッシュTTL
  if (s.cacheTtlSec !== null) {
    if (s.cacheTtlSec >= 60) {
      parts.push(`🅲 TTL:${Math.floor(s.cacheTtlSec / 60)}m${s.cacheTtlSec % 60}s`);
    } else {
      parts.push(`🅲 TTL:${s.cacheTtlSec}s`);
    }
  } else {
    parts.push('🅲 TTL:--');
  }

  // メモリ
  parts.push(`📊${s.memoryMb}MB`);

  // ping予約
  if (s.ping.nextAt) {
    const pingMs = new Date(s.ping.nextAt).getTime() - Date.now();
    if (pingMs > 0) {
      const pingMin = Math.ceil(pingMs / 60000);
      parts.push(`🅿${pingMin}m`);
    } else {
      parts.push('🅿now');
    }
  } else {
    parts.push('🅿--');
  }

  return parts.join(' ');
}

/** 軽量ping: lastActivityAt を現在時刻に更新 */
export function ping() {
  const state = readState();
  state.lastActivityAt = new Date().toISOString();
  writeState(state);
  return {};
}

/** ping予定時刻を計算（ISO文字列）し、stateに保存 */
export function schedulePing() {
  const state = readState();
  const at = new Date(Date.now() + PING_INTERVAL_SEC * 1000);
  state.pingScheduledAt = at.toISOString();
  state.pingIntervalSec = PING_INTERVAL_SEC;
  writeState(state);
  return { at: state.pingScheduledAt };
}

/** ping予約を解除 */
export function cancelPing() {
  const state = readState();
  state.pingScheduledAt = null;
  writeState(state);
  return { cancel: true };
}

// CLI として実行された場合
if (isEntry(import.meta.url)) {
  const flag = process.argv[2];

  switch (flag) {
    case '--status':
      process.stdout.write(JSON.stringify(cacheStatus()) + '\n');
      break;
    case '--statusline':
      process.stdout.write(cacheStatusLine() + '\n');
      break;
    case '--ping':
      ping();
      process.stdout.write('{}\n');
      break;
    case '--schedule-ping':
      process.stdout.write(JSON.stringify(schedulePing()) + '\n');
      break;
    case '--cancel-ping':
      process.stdout.write(JSON.stringify(cancelPing()) + '\n');
      break;
    default:
      process.stderr.write(
        `Usage: cache-monitor.mjs [--status|--statusline|--ping|--schedule-ping|--cancel-ping]\n`
      );
      process.exit(1);
  }
}