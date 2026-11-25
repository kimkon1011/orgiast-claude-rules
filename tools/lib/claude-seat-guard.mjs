import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readClaudeWindows } from './quota-windows.mjs';

const DEFAULT_WEEKLY_BLOCK_PERCENT = 95;
const FIVE_HOUR_BLOCK_PERCENT = 97;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function finitePercent(value) {
  if (value == null || String(value).trim() === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function writeObservation(home, verdict, now, caller) {
  const claudeDir = path.join(home, '.claude');
  const logsDir = path.join(claudeDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });
  const row = { at: new Date(now).toISOString(), blocked: verdict.blocked, reason: verdict.reason, weeklyPercent: verdict.weeklyPercent, fiveHourPercent: verdict.fiveHourPercent, resetsAt: verdict.resetsAt, caller };
  fs.writeFileSync(path.join(claudeDir, 'claude-seat-guard-state.json'), `${JSON.stringify({ ...verdict, caller, evaluatedAt: row.at }, null, 2)}\n`);
  fs.appendFileSync(path.join(logsDir, 'claude-seat-guard.log'), `${JSON.stringify(row)}\n`);
}

export async function evaluateClaudeSeatGuard({ home, now = Date.now, fetchImpl, env = process.env, caller = 'unknown', readWindows = readClaudeWindows } = {}) {
  if (!home) throw new Error('home is required');
  const at = typeof now === 'function' ? Number(now()) : Number(now);
  const pause = readJson(path.join(home, '.claude', 'claude-seat-guard-pause.json'));
  const pauseUntil = Date.parse(pause?.until ?? '');
  let verdict;
  if (Number.isFinite(pauseUntil) && pauseUntil > at) {
    verdict = { blocked: true, reason: pause?.reason ? `manual-pause:${pause.reason}` : 'manual-pause', weeklyPercent: null, fiveHourPercent: null, resetsAt: new Date(pauseUntil).toISOString(), source: 'pause-file' };
  } else {
    const simulated = finitePercent(env.ORGIAST_CLAUDE_GUARD_SIMULATE_WEEKLY);
    let windows = [];
    let source = 'oauth-usage';
    if (simulated != null) {
      windows = [{ window: '7d', usedPercent: simulated, resetsAt: at + 60 * 60_000 }];
      source = 'simulate';
    } else {
      try { windows = await readWindows({ home, now: () => at, fetchImpl }); } catch { windows = []; }
      if (windows?.fromCache) source = 'cache';
    }
    const weekly = windows.find(row => row.window === '7d');
    const fiveHour = windows.find(row => row.window === '5h');
    const weeklyPercent = finitePercent(weekly?.usedPercent);
    const fiveHourPercent = finitePercent(fiveHour?.usedPercent);
    const config = readJson(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'config', 'claude-seat-guard.json'), {});
    const weeklyThreshold = finitePercent(env.ORGIAST_CLAUDE_WEEKLY_GUARD_PCT) ?? finitePercent(config?.weeklyBlockPercent) ?? DEFAULT_WEEKLY_BLOCK_PERCENT;
    const weeklyFuture = Number.isFinite(weekly?.resetsAt) && weekly.resetsAt > at;
    const fiveHourFuture = Number.isFinite(fiveHour?.resetsAt) && fiveHour.resetsAt > at;
    if (weeklyPercent != null && weeklyPercent >= weeklyThreshold && weeklyFuture) {
      verdict = { blocked: true, reason: 'weekly-threshold', weeklyPercent, fiveHourPercent, resetsAt: new Date(weekly.resetsAt).toISOString(), source };
    } else if (fiveHourPercent != null && fiveHourPercent >= FIVE_HOUR_BLOCK_PERCENT && fiveHourFuture) {
      verdict = { blocked: true, reason: 'five-hour-threshold', weeklyPercent, fiveHourPercent, resetsAt: new Date(fiveHour.resetsAt).toISOString(), source };
    } else if (weeklyPercent == null && fiveHourPercent == null) {
      verdict = { blocked: false, reason: 'usage-unavailable', weeklyPercent: null, fiveHourPercent: null, resetsAt: null, source };
    } else {
      verdict = { blocked: false, reason: 'below-threshold', weeklyPercent, fiveHourPercent, resetsAt: null, source };
    }
  }
  writeObservation(home, verdict, at, caller);
  return verdict;
}

export function syncGbOffloadFlags({ home, verdict }) {
  const stateDir = path.join(home, 'gb-offload', 'state');
  if (!fs.existsSync(stateDir)) return { available: false, noNew: false, noResume: false };
  const files = ['no-new', 'no-resume'];
  if (verdict.blocked) {
    for (const name of files) {
      const file = path.join(stateDir, name);
      if (!fs.existsSync(file)) fs.writeFileSync(file, `set-by claude-seat-guard until=${verdict.resetsAt ?? 'unknown'} reason=${verdict.reason}\n`);
    }
  } else {
    for (const name of files) {
      const file = path.join(stateDir, name);
      try { if (fs.readFileSync(file, 'utf8').startsWith('set-by claude-seat-guard')) fs.unlinkSync(file); } catch {}
    }
  }
  return { available: true, noNew: fs.existsSync(path.join(stateDir, 'no-new')), noResume: fs.existsSync(path.join(stateDir, 'no-resume')) };
}

export function formatClaudeSeatGuardSkip(verdict) {
  return `[claude-seat-guard] skip: ${verdict.reason} until ${verdict.resetsAt ?? 'unknown'}`;
}
