import fs from 'node:fs';
import path from 'node:path';
import { fetchClaudePlanUsage } from '../claude-plan-usage.mjs';

const MINUTE = 60_000;
// The usage API returns resets_at with sub-second jitter that can land on either
// side of a minute boundary (実測: 01:59:59.x / 02:00:00.x, 15:00:00.192Z).
// Identity must survive that flip, so bucket to the nearest minute and compare
// with a tolerance instead of an exact key.
export const resetKey = value => Math.round(value / MINUTE) * MINUTE;
export const sameReset = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 2 * MINUTE;
export function parseCodexRateLimits(text) {
  let latest = null;
  // Read structured telemetry only. Quoted examples inside a user/tool message
  // are not observations (and can otherwise overwrite real usage data).
  for (const line of String(text ?? '').split(/\r?\n/)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (typeof row === 'string') { try { row = JSON.parse(row); } catch { continue; } }
    if (row && Object.hasOwn(row, 'rate_limits')) latest = row.rate_limits;
    else if (row?.payload && Object.hasOwn(row.payload, 'rate_limits')) latest = row.payload.rate_limits;
  }
  const window = (w) => w && [w.used_percent, w.window_minutes, w.resets_at].every(v => typeof v === 'number' && Number.isFinite(v))
    && w.used_percent >= 0 && w.window_minutes > 0 && w.resets_at > 0
    ? { usedPercent: w.used_percent, windowMinutes: w.window_minutes, resetsAt: w.resets_at * 1000 } : null;
  return { primary: window(latest?.primary), secondary: window(latest?.secondary), exhausted: latest != null && latest.primary === null };
}

export function jsonlFiles(root) {
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries.flatMap(e => e.isDirectory() ? jsonlFiles(path.join(root, e.name)) : e.isFile() && e.name.endsWith('.jsonl') ? [path.join(root, e.name)] : []);
}

export function readCodexWindows({ home, wslHome, now = Date.now() } = {}) {
  const roots = [home, ...(Array.isArray(wslHome) ? wslHome : [wslHome])].filter(Boolean);
  const files = roots.flatMap(root => jsonlFiles(path.join(root, '.codex', 'sessions'))).flatMap(file => {
    try { return [{ file, mtime: fs.statSync(file).mtimeMs }]; } catch { return []; }
  }).sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  if (!files.length) return Object.assign([], { reason: 'Codex session logs unavailable' });
  const { file, mtime: observedAt } = files[0];
  let parsed;
  try { parsed = parseCodexRateLimits(fs.readFileSync(file, 'utf8')); } catch { return Object.assign([], { reason: 'Codex latest log unreadable' }); }
  const metadata = { provider: 'codex', observedAt, stale: Number(now) - observedAt > 6 * 60 * MINUTE, exhausted: parsed.exhausted };
  const windows = ['primary', 'secondary'].filter(k => parsed[k]).map(k => ({ ...metadata, window: k, ...parsed[k] }));
  if (parsed.exhausted && !windows.length) windows.push({ ...metadata, window: 'primary', usedPercent: 100, resetsAt: null });
  return Object.assign(windows, { reason: windows.length ? null : 'No rate_limits in latest Codex log', observedAt, stale: metadata.stale });
}

// oauth/usage は 429 が十数分続くことがある（2026-10-24T14:13Z〜14:34Z / 10-25T03:16Z〜03:34Z に
// 15秒×3回の再試行が全滅して deferred が3連続）。成功した読み取りをディスクへ残し、一時障害のときだけ
// 短時間（既定10分）に限って直近の値を stale として返す。resets_at が過去なら使わない。
export const CLAUDE_WINDOW_CACHE_FILE = 'quota-claude-window-cache.json';
const TRANSIENT_USAGE_ERROR = /^(?:network:|HTTP (?:408|429|5\d{2})\b)/i;
export async function readClaudeWindows({ home, fetchImpl, now = Date.now, cacheMaxAgeMs = 10 * MINUTE } = {}) {
  const result = await fetchClaudePlanUsage({ home, fetchImpl: fetchImpl ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15_000) })) });
  const cacheFile = home ? path.join(home, '.claude', CLAUDE_WINDOW_CACHE_FILE) : null;
  if (!result.available) {
    if (cacheFile && TRANSIENT_USAGE_ERROR.test(String(result.reason ?? '').trim())) {
      try {
        const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8')), at = now();
        const usable = Number.isFinite(cached?.observedAt) && at - cached.observedAt >= 0 && at - cached.observedAt <= cacheMaxAgeMs
          && Array.isArray(cached.windows) && cached.windows.length === 2 && cached.windows.every(x => Number.isFinite(x.usedPercent) && Number.isFinite(x.resetsAt) && x.resetsAt > at);
        if (usable) return Object.assign(cached.windows.map(x => ({ provider: 'claude', window: x.window, usedPercent: x.usedPercent, resetsAt: x.resetsAt, stale: true, observedAt: cached.observedAt })), { reason: null, fromCache: result.reason });
      } catch { /* キャッシュ無し・破損は従来どおり失敗扱い */ }
    }
    return Object.assign([], { reason: result.reason });
  }
  const windows = [['5h', result.fiveHour], ['7d', result.sevenDay]].map(([window, value]) => ({ provider: 'claude', window, usedPercent: value.utilization, resetsAt: Date.parse(value.resetsAt) }));
  if (cacheFile && windows.every(x => Number.isFinite(x.resetsAt))) {
    try { fs.mkdirSync(path.dirname(cacheFile), { recursive: true }); fs.writeFileSync(cacheFile, JSON.stringify({ observedAt: now(), windows })); } catch { /* 書けなくても読み取り結果は返す */ }
  }
  return windows;
}

export function shouldStopTick({ windows, provider, hardCeilingPercent = 97 }) {
  const own = windows.filter(w => w.provider === provider);
  return !own.length || own.some(w => w.exhausted || !Number.isFinite(w.usedPercent) || w.usedPercent >= hardCeilingPercent);
}

export function decideSweep({ windows, now = Date.now(), leadMinutes = 90, minRemainingPercent = 15, marginMinutes = 3, hardCeilingPercent = 97, minRunMinutes = 10 }) {
  const decisions = [];
  for (const provider of ['claude', 'codex']) {
    const own = windows.filter(w => w.provider === provider);
    if (shouldStopTick({ windows, provider, hardCeilingPercent })) continue;
    if (provider === 'claude' && !['5h', '7d'].every(k => own.some(w => w.window === k && 100 - w.usedPercent >= minRemainingPercent))) continue;
    // An unused window (0% used) has no resets_at yet: it is not an active limit.
    // Any other non-finite reset is unknown state, so stay conservative.
    if (own.some(w => !Number.isFinite(w.resetsAt) && w.usedPercent !== 0)) continue;
    const active = own.filter(w => Number.isFinite(w.resetsAt));
    // Every concurrent limit must allow work; resetting any active window ends this run.
    if (active.some(w => w.resetsAt <= now || 100 - w.usedPercent < minRemainingPercent)) continue;
    const candidates = active.filter(w => w.resetsAt - now <= leadMinutes * MINUTE);
    if (!candidates.length) continue;
    const first = candidates.sort((a, b) => a.resetsAt - b.resetsAt)[0];
    const deadline = Math.min(...active.map(w => w.resetsAt)) - marginMinutes * MINUTE;
    if (deadline - now < minRunMinutes * MINUTE) continue;
    decisions.push({ provider, window: first.window, resetsAt: resetKey(first.resetsAt), deadline, usedPercent: first.usedPercent,
      remainingPercent: 100 - first.usedPercent, reason: `reset approaching${own.some(w => w.stale) ? '; stale: refresh before tick' : ''}` });
  }
  return decisions;
}
