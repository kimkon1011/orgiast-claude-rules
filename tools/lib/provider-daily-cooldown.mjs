import fs from 'node:fs';
import path from 'node:path';

export function isDailyQuotaResponse(status, detail, retryAfterMs = 0) {
  return status === 429 && (/\b(?:per day|TPD|RPD)\b/i.test(String(detail)) || retryAfterMs > 60000);
}

export function nextUtcMidnight(now = new Date()) { return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1); }

export function markDailyProviderCooldown(provider, { home, now = new Date(), fsImpl = fs } = {}) {
  const file = path.join(home, '.claude', 'provider-cooldown.json');
  let state = {}; try { state = JSON.parse(fsImpl.readFileSync(file, 'utf8')); } catch {}
  state[provider] = { until: nextUtcMidnight(now), reason: 'daily_limit', recordedAt: now.toISOString() };
  fsImpl.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fsImpl.renameSync(temporary, file);
  return state[provider];
}
