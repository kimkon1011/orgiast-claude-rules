// Shared state reader; tools/lib and VSIX copies must stay byte-identical.
const fs = require('node:fs');
const path = require('node:path');

function targetCount(value = 1) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new Error('待機数は 1..10 の整数で指定してください');
  return count;
}
// 決定順: env CLAUDE_MOBILE_STANDBY -> JSON の count -> fallback（VS Code 設定値）-> 1
function readConfig(home, env = process.env, fallback = 1) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'mobile-sessions.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return targetCount(env.CLAUDE_MOBILE_STANDBY ?? config.count ?? fallback);
}
function readSnapshot(home, now = Date.now()) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'mobile-sessions-state.json'), 'utf8'));
    if (now - state.updatedAt > 30000 || now < state.updatedAt || !Number.isInteger(state.waiting) || state.waiting < 0) return null;
    return state;
  } catch { return null; }
}
// --- 定期リフレッシュ設定（古い待機タブを閉じて作り直し、スマホ一覧の上に出す） ---
const DEFAULT_REFRESH_MINUTES = 60;
const DEFAULT_REFRESH_HOURS = '06-24';
function refreshMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error('リフレッシュ間隔は 0 以上の数値（分）で指定してください');
  return minutes;
}
// "06-24" -> {start:6,end:24}。終了は排他。不正な値は null。
function parseRefreshHours(value) {
  const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(String(value ?? ''));
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > 23 || end > 24) return null;
  return { start, end };
}
// start<end は同日内、start>end は日跨ぎ（例 22-06）、start===end は終日。
function inRefreshHours(date, hours) {
  const range = typeof hours === 'string' ? parseRefreshHours(hours) : hours;
  if (!range) return true;
  const hour = date.getHours();
  if (range.start === range.end) return true;
  return range.start < range.end ? hour >= range.start && hour < range.end : hour >= range.start || hour < range.end;
}
// 決定順: env CLAUDE_MOBILE_REFRESH_MINUTES / _HOURS -> JSON の refreshMinutes / refreshHours -> fallback（VS Code 設定）-> 既定
function readRefreshConfig(home, env = process.env, fallback = {}) {
  let config = {};
  try { config = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'mobile-sessions.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const minutes = refreshMinutes(env.CLAUDE_MOBILE_REFRESH_MINUTES ?? config.refreshMinutes ?? fallback.minutes ?? DEFAULT_REFRESH_MINUTES);
  const rawHours = env.CLAUDE_MOBILE_REFRESH_HOURS ?? config.refreshHours ?? fallback.hours ?? DEFAULT_REFRESH_HOURS;
  const hours = parseRefreshHours(rawHours) ? String(rawHours).trim() : DEFAULT_REFRESH_HOURS;
  return { minutes, hours };
}
// 状態ファイルの lastRefreshAt（拡張が書く）。期限切れでも読む。無ければ null。
function readLastRefreshAt(home) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'mobile-sessions-state.json'), 'utf8')).lastRefreshAt;
    return Number.isFinite(value) ? value : null;
  } catch { return null; }
}
module.exports = {
  targetCount, readConfig, readSnapshot,
  DEFAULT_REFRESH_MINUTES, DEFAULT_REFRESH_HOURS, parseRefreshHours, inRefreshHours, readRefreshConfig, readLastRefreshAt,
};
