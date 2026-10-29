import fs from 'node:fs';
import path from 'node:path';
import { normalizeExecutorStatus } from '../executor-status.mjs';
import { redactAll } from './redact.mjs';

// HTTP 429 / usage limit / cooldown は全て quota 系。cooldown は billing 系と排他（同じ行に cooldown + 402 は起こらない）。
export const quotaFailure = text => /HTTP[ _:]*429\b|\b429\b|cooldown|(?:usage|weekly|monthly)[_ /.-]*limit|limit[^\n]{0,60}exhausted|rate[_ .-]?limit|RESOURCE_EXHAUSTED|codex_cooldown/i.test(String(text));
// billing は 402 / insufficient balance|quota|credits / payment_required のみ。
// 429 や rate limit 由来の "Insufficient credits" を billing と誤判定しない（quotaFailure と順序で分離）。
export const billingFailure = text => /\b402\b|insufficient[_ ](?:balance|quota|credits?)|(?:credits?|balance)[ _-]*(?:are[ _-]*)?(?:depleted|exhausted|insufficient)|(?:out of|no|not enough|low) credits?|credit[_ -](?:balance|limit)[^\n]{0,40}(?:low|exceed|insufficient|depleted|exhausted)|payment_required/i.test(String(text));
// 文言に 429 を含む billing は偽の billing（実際は quota）。判定補助。
export const billingWithQuotaHint = text => billingFailure(text) && /HTTP[ _:]*429|\b429\b|rate[_ .-]?limit|cooldown/i.test(String(text));
// Provider timestamps without an offset are interpreted in the host timezone.
export function quotaReset(text) {
  return Date.parse(String(text).match(/(?:reset(?:s|ting)?(?: at)?|retry at)\s*[:=]?\s*(\d{4}-\d\d-\d\d[ T]\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:?\d\d)?)/i)?.[1]);
}
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
    // cooldown 状態の行は常に quota 扱い（実機: glm が 70 件の cooldown 行を持ち real_fail_rate と誤判定）。
    if (row.status === 'cooldown' || quotaFailure(detail)) {
      s.quotaCalls++;
      if (row.status === 'cooldown') s.lastQuotaAt = Math.max(s.lastQuotaAt, at);
      else {
        s.lastQuotaAt = Math.max(s.lastQuotaAt, at);
        const until = millis(row.retryAt ?? row.until ?? row.resetAt) || quotaReset(detail);
        if (until > now && (!s.until || until > s.until)) s.until = until;
      }
      continue;
    }
    if (billingFailure(detail)) {
      s.billingCalls++;
      s.lastBillingAt = Math.max(s.lastBillingAt, at);
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
    // Reclassify legacy/persisted billing or real_fail_rate that is actually quota
    if ((state.reason === 'billing' || state.reason === 'real_fail_rate')
      && (quotaFailure(state.error) || quotaFailure(state.reason) || (s?.quotaCalls && !s.billingCalls && !s.failures))) {
      state.reason = 'quota_wait';
      state.until ||= s?.until || quotaReset(state.error) || null;
    }
    if ((!state.alive && quotaFailure(`${state.reason} ${state.error || ''}`))
      || (s?.quotaCalls && (!s.until || s.until > now) && s.lastQuotaAt > s.lastOkAt)) {
      state.alive = false;
      state.reason = 'quota_wait';
      state.until ||= s?.until || quotaReset(state.error) || null;
    } else if (s?.calls >= 5 && s.failRate >= .5) {
      state.alive = false;
      state.reason = 'real_fail_rate';
      state.error = Object.entries(s.reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`).join('; ');
    // A gateway probe does not prove the original wallet was replenished.
    // Only a later successful real call supersedes ledger billing evidence.
    } else if ((s?.billingCalls && s.lastBillingAt >= s.lastOkAt && !quotaFailure(`${state.reason} ${state.error || ''}`))
      || (!state.alive && billingFailure(`${state.reason} ${state.error || ''}`) && !quotaFailure(`${state.reason} ${state.error || ''}`))) {
      state.alive = false;
      state.reason = 'billing';
    }
  }
  return health;
}
