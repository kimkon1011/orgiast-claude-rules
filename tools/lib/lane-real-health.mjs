import fs from 'node:fs';
import path from 'node:path';
import { normalizeExecutorStatus } from '../executor-status.mjs';
import { redactAll } from './redact.mjs';
import { GATEWAY_MODELS } from '../provider-routing.mjs';

export const LANE_NAMES = ['codex', 'gemini', 'deepseek', 'groq', 'openrouter', 'glm', 'grok', 'mistral', 'kimi'];
// Routing diagnostics describe other invocations, never this provider's HTTP response.
export function laneErrorText(text, lane) {
  return String(text || '').split(/\r?\n/).filter(line =>
    !/\[codex-do\]|\[routing\]|fallback backend=|cheap-first:|ack backend=/i.test(line)
    && !LANE_NAMES.some(other => other !== lane && new RegExp(`\\b${other}\\b`, 'i').test(line))
  ).join('\n');
}
// [routing] / [cooldown] / [codex-do] は「どのレーンが答えたか」ではなく経路の診断。
// ここに並ぶ他レーン名を連鎖の証拠にすると、自レーンが答えた probe まで判定不能に落ちる
// （2026-11-17 実測: openrouter が答えているのに冒頭の [routing] gemini… で probe_inconclusive）。
const DIAGNOSTIC_LINE = /^\s*\[(?:routing|cooldown|codex-do)\]/i;
// [routing] の demote 診断行（provider 名 fallback）で誤判定した 2026-11-17 実測。
// 実際の連鎖は cheap-first: / fallback backend= / ack backend= で表れる。
const CHAIN_MARKER = /cheap-first:|fallback backend=|ack backend=/i;
// [openrouter:deepseek/deepseek-v4-flash] は OpenRouter 経由の正規経路レーンを示すタグ。
// そのレーン自身が OpenRouter 経由で答えたなら連鎖ではないので、タグを除去してから判定する。
const OPENROUTER_TAG = /\[openrouter:([^\]\s]+)\]/gi;
function stripOpenrouterTag(line, lane) {
  return line.replace(OPENROUTER_TAG, (tag, model) =>
    lane === 'openrouter' || model.toLowerCase().includes(String(lane).toLowerCase()) ? '' : tag);
}
// 2026-11-20 実測: codex 書き込み probe が成功していても、再掲された MEMORY.md 索引の
// deepseek 等を拾って probe_inconclusive になったため、入力の再掲部分だけを除く。
export function stripCodexPromptEcho(text) {
  const value = String(text);
  const newline = value.includes('\r\n') ? '\r\n' : '\n';
  const lines = value.split(/\r?\n/);
  let separatorSeen = false;
  let changed = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*--------\s*$/.test(lines[i])) separatorSeen = true;
    if (!separatorSeen || !/^\s*user\s*$/.test(lines[i])) continue;
    const end = lines.findIndex((line, index) => index > i
      && /^\s*(?:codex|exec|thinking|tokens used)\s*$/.test(line));
    lines.splice(i, end === -1 ? lines.length - i : end - i);
    changed = true;
    if (end === -1) break;
    i--;
  }
  return changed ? lines.join(newline) : value;
}
export function probeViaChain(text, lane) {
  return stripCodexPromptEcho(text).split(/\r?\n/).some(line =>
    CHAIN_MARKER.test(line)
    || (!DIAGNOSTIC_LINE.test(line)
      && LANE_NAMES.some(other => other !== lane && new RegExp(`\\b${other}\\b`, 'i').test(stripOpenrouterTag(line, lane)))));
}

// Match the actual HTTP failure line before routing diagnostics filter OpenRouter out.
export function retiredModel(text, lane) {
  for (const line of String(text || '').split(/\r?\n/)) {
    if (DIAGNOSTIC_LINE.test(line) || CHAIN_MARKER.test(line)) continue;
    if (!/HTTP\s*404\b/i.test(line) || !/no longer available|No endpoints found/i.test(line)) continue;
    const match = line.match(/(?:^|\s)([\w-]+):([\w.-]+\/[\w./:-]+)\s+HTTP\s*404\b/i);
    if (match) {
      const [, provider, model] = match;
      if (provider === lane || (provider === 'openrouter' && GATEWAY_MODELS[lane]?.split('/')[0] === model.split('/')[0])) return model;
      continue;
    }
    if (GATEWAY_MODELS[lane]) return GATEWAY_MODELS[lane];
  }
  return null;
}

const AUTH_DOMINANT_RATIO = 0.9;
const AUTH_MIN_FAILURES = 5;

// HTTP 429 / usage limit / cooldown は全て quota 系。cooldown は billing 系と排他（同じ行に cooldown + 402 は起こらない）。
const http402 = text => /(?<!\d)402(?!\d)/.test(String(text));
const http403 = text => /(?<!\d)403(?!\d)/.test(String(text));
const http429 = text => /(?<!\d)429(?!\d)/.test(String(text));
export const authFailurePattern = /basic authentication|HTTP\s*401|\b401\b|unauthorized|login required|token.*expired|Missing bearer|Failed to refresh token|access token could not be refreshed|log out and sign in again|sign in again|refresh_token|token_revoked|invalid_grant|invalid_api_key|not logged in/i;
// ChatGPT/Codex の定額枠切れは 429 も "usage limit" も含まず
// 「Upgrade to Pro ... purchase more credits or try again at <時刻>」という散文で届く。
// 2026-11-22 実測: これを quota と読めず real_fail_rate に積み上がり、
// lane-repair-first-gate が全セッションの編集・シェルを封鎖した。
export const chatgptUsageLimit = text => /chatgpt\.com\/settings\/usage|upgrade to pro[^\n]{0,300}try again at|you(?:['’]ve| have) (?:hit|reached)[^\n]{0,60}limit/i.test(String(text));
export const quotaFailure = text => http429(text) || chatgptUsageLimit(text) || /cooldown|(?:usage|weekly|monthly)[_ /.-]*limit|limit[^\n]{0,60}exhausted|rate[_ .-]?limit|RESOURCE_EXHAUSTED|codex_cooldown/i.test(String(text));
// billing は 402 / insufficient balance|quota|credits / payment_required のみ。
// 429 や rate limit 由来の "Insufficient credits" を billing と誤判定しない（quotaFailure と順序で分離）。
// xAI/Grok 403: "used all available credits or reached its monthly spending limit ... purchase more credits"
// は credit depleted と同型の課金切れ。ChatGPT の "purchase more credits or try again at" は含めない。
export const billingFailure = text => http402(text)
  || (/outstanding balance|billing account[^\n]{0,80}(?:disabled|closed|suspended|outstanding|not active)/i.test(String(text)) && http403(text))
  || /insufficient[_ ](?:balance|quota|credits?)|(?:credits?|balance)[ _-]*(?:are[ _-]*)?(?:depleted|exhausted|insufficient)|(?:out of|no|not enough|low) credits?|credit[_ -](?:balance|limit)[^\n]{0,40}(?:low|exceed|insufficient|depleted|exhausted)|used all available credits|monthly spending limit|purchase more credits or raise|payment_required/i.test(String(text));
// 文言に 429 を含む billing は偽の billing（実際は quota）。判定補助。
export const billingWithQuotaHint = text => billingFailure(text) && (http429(text) || chatgptUsageLimit(text) || /rate[_ .-]?limit|cooldown/i.test(String(text)));
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
    const s = providers[row.provider] ||= { calls: 0, failures: 0, quotaCalls: 0, billingCalls: 0, lastBillingAt: 0, failRate: 0, reasons: {}, until: null, lastOkAt: 0, lastQuotaAt: 0, events: [] };
    s.calls++;
    const event = { at };
    s.events.push(event);
    if (status === 'ok') { s.lastOkAt = Math.max(s.lastOkAt, at); continue; }
    const detail = laneErrorText([row.status, row.httpStatus, row.http_status, row.reason, row.error, row.stderr, row.stderrTail, row.spawnError].filter(Boolean).join('\n'), row.provider);
    const authFailure = authFailurePattern.test(detail);
    // 認証切れを先に判定し、それ以外の cooldown は quota 扱い（実機: glm が 70 件の cooldown 行を持ち real_fail_rate と誤判定）。
    // 402 は RESOURCE_EXHAUSTED を伴うことがある。429 も同居する場合だけ quota を優先する。
    if (!authFailure && row.status !== 'cooldown' && billingFailure(detail) && !billingWithQuotaHint(detail)) {
      s.billingCalls++;
      s.lastBillingAt = Math.max(s.lastBillingAt, at);
      continue;
    }
    if (!authFailure && (row.status === 'cooldown' || quotaFailure(detail))) {
      s.quotaCalls++;
      s.lastQuotaAt = Math.max(s.lastQuotaAt, at);
      const until = millis(row.retryAt ?? row.until ?? row.resetAt) || quotaReset(detail);
      if (Number.isFinite(until) && (!s.until || until > s.until)) s.until = until;
      continue;
    }
    s.failures++;
    const http = detail.match(/(?:HTTP[ _:]*|(?:^|\s))([45]\d\d)\b/i)?.[1];
    const reason = authFailure && /\b401\b/.test(detail) ? 'HTTP 401' : redactAll(http ? `HTTP ${http}` : laneErrorText(row.reason || row.stderr || row.stderrTail || row.spawnError || row.status, row.provider).split(/\r?\n/)[0]).slice(0, 180);
    if (authFailure) event.authFailure = true;
    event.reason = reason;
    s.reasons[reason] = (s.reasons[reason] || 0) + 1;
  }
  for (const s of Object.values(providers)) s.failRate = s.calls ? s.failures / s.calls : 0;
  return providers;
}

export function applyRealLaneHealth(health, home, now = Date.now(), classifiedAutoProbes) {
  const stats = realLaneStats(home, now);
  for (const [lane, state] of Object.entries(health.lanes)) {
    const s = stats[lane];
    if (s) state.real24h = s;
    // A fresh probe of an auto-disabled lane supersedes the events that disabled it.
    if (classifiedAutoProbes?.has(lane)) continue;
    if (state.reason === 'model_retired') { state.alive = false; continue; }
    if (state.error && probeViaChain(state.error, lane)) { state.viaChain = true; state.reason = 'probe_inconclusive'; }
    if (state.error !== undefined) state.error = laneErrorText(state.error, lane);
    if (state.reason === 'billing' && s?.billingCalls === 0 && s.lastOkAt >= now - 6 * 3600_000 && s.lastOkAt <= now && (state.billingProbeStreak || 0) < 2) state.reason = 'probe_inconclusive';
    if (state.viaChain || state.reason === 'probe_inconclusive') {
      state.alive = false;
      state.reason = 'probe_inconclusive';
      continue;
    }
    const errorQuota = quotaFailure(state.error) && !(billingFailure(state.error) && !billingWithQuotaHint(state.error));
    const errorUntil = quotaReset(state.error);
    // A direct probe success after the last 429 proves the quota window is over.
    const probeOkAt = millis(state.lastProbeOkAt) || 0;
    const ledgerQuota = s?.quotaCalls && (!s.until || s.until > now) && s.lastQuotaAt > Math.max(s.lastOkAt || 0, probeOkAt);
    // Only this lane's error, ledger or active cooldown may supply a reset.
    const stateUntil = millis(state.until);
    const cooldownQuota = !state.alive && quotaFailure(state.reason)
      && Number.isFinite(stateUntil) && stateUntil > now;
    const quota = ledgerQuota || (errorQuota && (!Number.isFinite(errorUntil) || errorUntil > now)) || cooldownQuota;
    const until = Math.max(ledgerQuota ? s.until || 0 : 0,
      errorQuota && errorUntil > now ? errorUntil : 0, cooldownQuota ? stateUntil : 0) || null;
    // Evaluate only calls after the latest proven recovery, independent of ledger order.
    const lastOkAt = Math.max(s?.lastOkAt || 0, probeOkAt);
    const calls = s?.events.filter(event => event.at > lastOkAt) || [];
    const failures = calls.filter(event => event.reason !== undefined);
    const isAuth = event => event.authFailure || authFailurePattern.test(event.reason || '');
    const freshAuth = !state.alive && (
      failures.some(isAuth)
      || (authFailurePattern.test(String(state.error || '')) && (!lastOkAt || millis(state.probedAt) > lastOkAt))
    );
    if (freshAuth) {
      state.reason = lane === 'codex' ? 'dead:oauth_consent' : 'auth_invalid';
      delete state.until;
    } else if (calls.length >= 5 && failures.length / calls.length >= .5) {
      const authFailures = failures.filter(isAuth);
      const authDominant = authFailures.length >= AUTH_MIN_FAILURES && authFailures.length / failures.length >= AUTH_DOMINANT_RATIO;
      if (authDominant) {
        state.alive = false;
        state.reason = lane === 'codex' ? 'dead:oauth_consent' : 'auth_invalid';
        delete state.until;
        state.error = failures.map(event => event.reason).filter(Boolean).join('; ');
        const otherFailures = failures.filter(event => !isAuth(event));
        if (otherFailures.length) {
          const topOther = Object.entries(otherFailures.reduce((reasons, event) => { reasons[event.reason] = (reasons[event.reason] || 0) + 1; return reasons; }, {})).sort((a, b) => b[1] - a[1])[0][0];
          state.error += `; 認証系 ${authFailures.length}件 / その他 ${otherFailures.length}件: ${topOther}`;
        }
      } else {
        // real_fail_rate に先立ち、probeReason/probeEvidence が cooldown/quota を示す場合は
        // quota_wait にする。そうしないと lane-repair-first-gate が全作業を封鎖する行き止まりになる（2026-11-26）。
        const probeQuota = quotaFailure(state.probeReason || '') || /quota_wait/i.test(state.probeReason || '')
          || quotaFailure(state.probeEvidence || '') || /quota_wait/i.test(state.probeEvidence || '');
        if (probeQuota) {
          state.alive = false;
          state.reason = 'quota_wait';
          state.until = s?.until || state.until || null;
          state.error = Object.entries(failures.reduce((reasons, event) => { reasons[event.reason] = (reasons[event.reason] || 0) + 1; return reasons; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`).join('; ');
        } else {
          state.alive = false;
          state.reason = 'real_fail_rate';
          delete state.until;
          state.error = Object.entries(failures.reduce((reasons, event) => { reasons[event.reason] = (reasons[event.reason] || 0) + 1; return reasons; }, {})).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r, n]) => `${r} (${n})`).join('; ');
        }
      }
    // A later real success supersedes wallet evidence; gateway probes do not.
    } else if ((s?.billingCalls > (s?.quotaCalls || 0) && s.lastBillingAt >= s.lastOkAt)
      || (!quota && !state.alive && billingFailure(`${state.reason} ${state.error || ''}`))) {
      state.alive = false;
      state.reason = 'billing';
      delete state.until;
    } else if (quota) {
      state.alive = false;
      state.reason = 'quota_wait';
      state.until = until;
    } else if (state.until && stateUntil <= now) {
      delete state.until;
    }
  }
  return health;
}
