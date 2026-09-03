import fs from 'node:fs';
import path from 'node:path';

const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

export function parseCodexResetUntil(output, now = Date.now()) {
  const text = String(output ?? '');
  const relative = /\b(?:try\s+again\s+)?in\s+(?:(\d+(?:\.\d+)?)\s*(?:h|hours?)\b)?(?:\s*(\d+(?:\.\d+)?)\s*(?:m|minutes?)\b)?/i.exec(text);
  if (relative && (relative[1] != null || relative[2] != null)) {
    return now + (Number(relative[1]) || 0) * HOUR + (Number(relative[2]) || 0) * MINUTE;
  }

  const reset = /\bresets?(?:\s+at)?\s+([^\r\n,;]+)/i.exec(text);
  if (reset) {
    const value = reset[1].trim();
    const clock = /^(\d{1,2}):(\d{2})(?:\s*(am|pm))?\b/i.exec(value);
    if (clock) {
      let hour = Number(clock[1]);
      const minute = Number(clock[2]);
      const meridiem = clock[3]?.toLowerCase();
      if (meridiem && hour >= 1 && hour <= 12) hour = (hour % 12) + (meridiem === 'pm' ? 12 : 0);
      if (hour <= 23 && minute <= 59) {
        const date = new Date(now);
        date.setHours(hour, minute, 0, 0);
        if (date.getTime() <= now) date.setDate(date.getDate() + 1);
        return date.getTime();
      }
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }

  return now + HOUR;
}

export function codexCooldownRemaining(now = Date.now(), cooldownFile) {
  if (!cooldownFile) return 0;
  try {
    const state = JSON.parse(fs.readFileSync(cooldownFile, 'utf8'));
    return Math.max(0, Number(state?.codex?.until) - now) || 0;
  } catch {
    return 0;
  }
}

export function recordCodexUsageLimit(output, cooldownFile, now = Date.now()) {
  try {
    let state = {};
    try { state = JSON.parse(fs.readFileSync(cooldownFile, 'utf8')); } catch {}
    if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
    state.codex = { until: parseCodexResetUntil(output, now), reason: 'usage_limit', at: now };
    fs.mkdirSync(path.dirname(cooldownFile), { recursive: true });
    fs.writeFileSync(cooldownFile, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch {}
}
