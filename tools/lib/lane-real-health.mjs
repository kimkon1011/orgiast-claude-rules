import fs from 'node:fs';
import path from 'node:path';
import { normalizeExecutorStatus } from '../executor-status.mjs';
import { redactAll } from './redact.mjs';

export const quotaFailure = text => /\b429\b|usage[_ ]limit|rate[_ .-]?limit|RESOURCE_EXHAUSTED|codex_cooldown/i.test(String(text));
const millis = value => typeof value === 'number' ? value : Date.parse(value);

// Same ledger as cost-work-loop/collectProviderHealth. Read the complete 24h
// window, not a fixed byte tail (a busy provider can produce thousands of rows).
export function realLaneStats(home, now = Date.now()) {
  const providers = {};
  let raw;
  try { raw = fs.readFileSync(path.join(home, '.claude/executor-usage.jsonl'), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return providers; throw e; }
  for (const line of raw.split(/\r?\n/)) {
    let row; try { row = JSON.parse(line); } catch { continue; }
    const at = millis(row.t || row.ts);
    if (!Number.isFinite(at) || at < now - 86400_000 || at > now) continue;
    const status = normalizeExecutorStatus(row);
    if (status === 'unrouted' || !row.provider) continue;
    const s = providers[row.provider] ||= { calls: 0, failures: 0, quotaCalls: 0, failRate: 0, reasons: {}, until: null };
    s.calls++;
    if (status === 'ok') continue;
    const detail = [row.status, row.reason, row.stderr, row.stderrTail, row.spawnError].filter(Boolean).join(' ');
    if (quotaFailure(detail)) {
      s.quotaCalls++;
      const until = millis(row.retryAt ?? row.until ?? row.resetAt);
      if (until > now && (!s.until || until > s.until)) s.until = until;
      continue;
    }
    s.failures++;
    const http = detail.match(/(?:HTTP[ _:]*)?\b([45]\d\d)\b/i)?.[1];
    const reason = redactAll(http ? `HTTP ${http}` : String(row.reason || row.stderr || row.stderrTail || row.spawnError || row.status).split(/\r?\n/)[0]).slice(0, 180);
    s.reasons[reason] = (s.reasons[reason] || 0) + 1;
  }
  for (const s of Object.values(providers)) s.failRate = s.calls ? s.failures / s.calls : 0;
  return providers;
}

export function applyRealLaneHealth(health, home, now = Date.now()) {
  const stats = realLaneStats(home, now);
  for (const [lane, state] of Object.entries(health.lanes)) {
    const s = stats[lane];
    if (s) state.real24h = s;
    // Actual failures take precedence even if the lightweight probe succeeded.
    if (s?.calls >= 5 && s.failRate >= .5) {
      state.alive = false;
      state.reason = 'real_fail_rate';
      state.error = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`).join('; ');
    } else if (!state.alive && quotaFailure(state.reason) && millis(state.until) > now || s?.quotaCalls && s.until > now && !state.alive) {
      state.reason = 'quota_wait';
      state.until ||= s?.until;
    }
  }
  return health;
}
