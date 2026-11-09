#!/usr/bin/env node
// X-0017: キャッシュ監視で20倍コスト増を防止 — プロンプトキャッシュTTL監視ツール
//
// 使い方:
//   node tools/cache-monitor.mjs --status        → 状態JSON
//   node tools/cache-monitor.mjs --statusline     → ステータスバー用1行
//   node tools/cache-monitor.mjs --ping           → キャッシュ維持ping
//   node tools/cache-monitor.mjs --schedule-ping  → CronCreate用情報出力
//   node tools/cache-monitor.mjs --cancel-ping    → CronDelete用情報出力
//
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

export const CACHE_TTL_SEC = 300;        // Anthropic prompt cache TTL: 5分
export const PING_INTERVAL_SEC = 1500;   // 25分

export function stateDir(home) {
  return path.join(home || process.env.ORGIAST_HOME || os.homedir(), '.claude', 'cache-monitor');
}

export function statePath(home) {
  return path.join(stateDir(home), 'state.json');
}

export function readState(home) {
  try {
    const raw = fs.readFileSync(statePath(home), 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function writeState(state, home) {
  try {
    fs.mkdirSync(stateDir(home), { recursive: true });
    fs.writeFileSync(statePath(home), JSON.stringify(state, null, 2) + '\n', 'utf8');
  } catch {
    // fail-open
  }
}

/**
 * Calculate current cache status.
 * Returns { cacheTtlSec, cacheExpired, subscription, memoryMb, ping, timestamp }
 */
export function cacheStatus(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const now = options.now || Date.now();
  const state = readState(home);

  // Cache TTL: 最後のアクティビティから5分 - 経過時間
  let cacheTtlSec = null;
  let cacheExpired = true;
  if (state.lastActivityAt) {
    const elapsed = (now - Date.parse(state.lastActivityAt)) / 1000;
    cacheTtlSec = Math.max(0, Math.round(CACHE_TTL_SEC - elapsed));
    cacheExpired = cacheTtlSec <= 0;
  }

  // Subscription tier
  let subscription = 'unknown';
  try {
    const claudeJsonPath = path.join(home, '.claude', 'claude.json');
    if (fs.existsSync(claudeJsonPath)) {
      const claude = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
      if (claude.subscription) subscription = claude.subscription;
    }
  } catch {
    // fail-open
  }

  // Memory usage
  let memoryMb = 0;
  try {
    const usage = process.memoryUsage();
    if (usage && typeof usage.rss === 'number') {
      memoryMb = Math.round(usage.rss / 1024 / 1024);
    }
  } catch {
    // fail-open
  }

  // Ping schedule
  let pingNextAt = null;
  if (state.pingScheduledAt) {
    pingNextAt = state.pingScheduledAt;
  }

  return {
    cacheTtlSec,
    cacheExpired,
    subscription,
    memoryMb,
    ping: {
      nextAt: pingNextAt,
      intervalSec: PING_INTERVAL_SEC,
    },
    timestamp: new Date(now).toISOString(),
  };
}

/**
 * Output one line for status bar display.
 * Format: 🅲 TTL:5m0s 📊61MB 🅿25m (or 🅿--)
 */
export function cacheStatusLine(options = {}) {
  const status = cacheStatus(options);
  const parts = [];

  // Cache TTL
  if (status.cacheTtlSec !== null && !status.cacheExpired) {
    const min = Math.floor(status.cacheTtlSec / 60);
    const sec = status.cacheTtlSec % 60;
    parts.push(`🅲 TTL:${min}m${sec}s`);
  } else if (status.cacheTtlSec !== null) {
    parts.push('🅲 TTL:expired');
  } else {
    parts.push('🅲 TTL:--');
  }

  // Memory
  if (status.memoryMb > 0) {
    parts.push(`📊${status.memoryMb}MB`);
  }

  // Ping
  if (status.ping.nextAt) {
    const pingRemaining = Math.max(0, Math.round((Date.parse(status.ping.nextAt) - Date.now()) / 60));
    parts.push(`🅿${pingRemaining}m`);
  } else {
    parts.push('🅿--');
  }

  return parts.join(' ');
}

/**
 * Execute a lightweight cache ping: update lastActivityAt.
 * This simulates a tool call to keep the cache alive.
 * Returns {} (nothing logged to conversation).
 */
export function ping(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const now = options.now || Date.now();
  const state = readState(home);
  state.lastActivityAt = new Date(now).toISOString();
  writeState(state, home);
  return {};
}

/**
 * Compute the scheduled ping time (25 min from now) for CronCreate.
 * Returns { at: ISO-string }.
 */
export function schedulePing(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const now = options.now || Date.now();
  const at = new Date(now + PING_INTERVAL_SEC * 1000).toISOString();
  const state = readState(home);
  state.pingScheduledAt = at;
  writeState(state, home);
  return { at };
}

/**
 * Cancel the scheduled ping. Clears pingScheduledAt.
 * Returns { cancel: true }.
 */
export function cancelPing(options = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const state = readState(home);
  state.pingScheduledAt = null;
  writeState(state, home);
  return { cancel: true };
}

// ---------- CLI ----------

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    console.log(JSON.stringify(cacheStatus()));
  } else if (args.includes('--statusline')) {
    console.log(cacheStatusLine());
  } else if (args.includes('--ping')) {
    const result = ping();
    console.log(JSON.stringify(result));
  } else if (args.includes('--schedule-ping')) {
    const result = schedulePing();
    console.log(JSON.stringify(result));
  } else if (args.includes('--cancel-ping')) {
    const result = cancelPing();
    console.log(JSON.stringify(result));
  } else {
    console.log(`X-0017: キャッシュ監視ツール

使い方:
  node tools/cache-monitor.mjs --status        キャッシュ状態をJSON出力
  node tools/cache-monitor.mjs --statusline     ステータスバー用1行
  node tools/cache-monitor.mjs --ping           キャッシュ維持ping
  node tools/cache-monitor.mjs --schedule-ping  25分後のpingを予約
  node tools/cache-monitor.mjs --cancel-ping    ping予約を取消`);
  }
}