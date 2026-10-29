import fs from 'node:fs';
import path from 'node:path';
import { normalizeExecutorStatus } from '../executor-status.mjs';
import { redactAll } from './redact.mjs';

export const quotaFailure = text => /\b429\b|usage[_ ]limit|rate[_ .-]?limit|RESOURCE_EXHAUSTED|codex_cooldown/i.test(String(text));
export const billingFailure = text => /\b402\b|insufficient[_ ](?:balance|quota|credits?)|(?:credits?|balance)[ _-]*(?:are[ _-]*)?(?:depleted|exhausted|insufficient)|(?:out of|no|not enough|low) credits?|credit[_ -](?:balance|limit)[^\n]{0,40}(?:low|exceed|insufficient|depleted|exhausted)|payment_required|\bbilling\b/i.test(String(text));
const millis = value => typeof value === 'number' ? value : Date.parse(value);

// cost-work-loop/collectProviderHealth use this same ledger. Read the full 24h
// window: a fixed byte tail loses failures on busy providers.
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
    const s = providers[row.provider] ||= { calls: 0, failures: 0, quotaCalls: 0, billingCalls: 0, lastBillingAt: 0, failRate: 0, reasons: {}, until: null, lastOkAt: 0, lastQuotaAt: 0 };
    s.calls++;
    if (status === 'ok') { s.lastOkAt = Math.max(s.lastOkAt, at); continue; }
    const detail = [row.status, row.httpStatus, row.http_status, row.reason, row.stderr, row.stderrTail, row.spawnError].filter(Boolean).join(' ');
    if (billingFailure(detail)) {
      s.billingCalls++;
      s.lastBillingAt = Math.max(s.lastBillingAt, at);
      continue;
    }
    if (quotaFailure(detail)) {
      s.quotaCalls++;
      s.lastQuotaAt = Math.max(s.lastQuotaAt, at);
      const until = millis(row.retryAt ?? row.until ?? row.resetAt);
      if (until > now && (!s.until || until > s.until)) s.until = until;
      continue;
    }
    s.failures++;
    const http = detail.match(/(?:HTTP[ _:]*|(?:^|\s))([45]\d\d)\b/i)?.[1];
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
    if (s?.calls >= 5 && s.failRate >= .5) {
      state.alive = false;
      state.reason = 'real_fail_rate';
      state.error = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`).join('; ');
    // A gateway probe does not prove the original wallet was replenished.
    // Only a later successful real call supersedes ledger billing evidence.
    } else if ((s?.billingCalls && s.lastBillingAt >= s.lastOkAt)
      || (!state.alive && billingFailure(`${state.reason} ${state.error || ''}`))) {
      state.alive = false;
      state.reason = 'billing';
    } else if ((!state.alive && quotaFailure(`${state.reason} ${state.error || ''}`) && millis(state.until) > now)
      || (s?.quotaCalls && s.until > now && s.lastQuotaAt >= s.lastOkAt)) {
      state.alive = false;
      state.reason = 'quota_wait';
      state.until ||= s?.until;
    }
  }
  return health;
}
