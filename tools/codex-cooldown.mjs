import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const HOUR_MS = 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const MONTHS = new Map([
  ['jan', 0], ['january', 0], ['feb', 1], ['february', 1],
  ['mar', 2], ['march', 2], ['apr', 3], ['april', 3],
  ['may', 4], ['jun', 5], ['june', 5], ['jul', 6], ['july', 6],
  ['aug', 7], ['august', 7], ['sep', 8], ['september', 8],
  ['oct', 9], ['october', 9], ['nov', 10], ['november', 10],
  ['dec', 11], ['december', 11],
]);

function defaultCooldownFile() {
  const home = process.env.ORGIAST_HOME || os.homedir();
  return path.join(home, '.claude', 'provider-cooldown.json');
}

export function parseCodexResetUntil(output, now = Date.now()) {
  const text = String(output || '');
  const relative = text.match(/(?:try\s+again\s+)?(?:in\s+)?(?:(\d+)\s*(?:h|hours?))?\s*(?:(\d+)\s*(?:m|minutes?))(?=\b|\d|$)/i)
    || text.match(/(?:try\s+again\s+)?in\s+(\d+)\s*(hours?)(?=\b)/i);
  if (relative) {
    const hours = relative[2]?.toLowerCase().startsWith('hour') ? Number(relative[1]) : Number(relative[1] || 0);
    const minutes = relative[2]?.toLowerCase().startsWith('hour') ? 0 : Number(relative[2] || 0);
    const duration = hours * HOUR_MS + minutes * MINUTE_MS;
    if (duration > 0) return now + duration;
  }

  const monthDateTime = text.match(/\b(?:try\s+again\s+at|resets?(?:\s+at)?)\s+(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM))?(?:\s*\((UTC|GMT)\)|\s+(Z|[+-]\d{2}:?\d{2}))?/i);
  if (monthDateTime) {
    const month = MONTHS.get(monthDateTime[1].toLowerCase());
    const day = Number(monthDateTime[2]);
    const explicitYear = monthDateTime[3] !== undefined;
    let year = explicitYear ? Number(monthDateTime[3]) : new Date(now).getFullYear();
    let hour = Number(monthDateTime[4]);
    const minute = Number(monthDateTime[5]);
    const meridiem = monthDateTime[6]?.toUpperCase();
    if (meridiem) hour = (hour % 12) + (meridiem === 'PM' ? 12 : 0);
    const zone = monthDateTime[7] || monthDateTime[8];
    const makeTimestamp = (candidateYear) => {
      if (zone && !/^(?:UTC|GMT|Z)$/i.test(zone)) {
        const normalizedZone = zone.includes(':') ? zone : `${zone.slice(0, 3)}:${zone.slice(3)}`;
        return Date.parse(`${candidateYear}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00${normalizedZone}`);
      }
      return /^(?:UTC|GMT|Z)$/i.test(zone || '')
        ? Date.UTC(candidateYear, month, day, hour, minute, 0, 0)
        : new Date(candidateYear, month, day, hour, minute, 0, 0).getTime();
    };
    let parsed = makeTimestamp(year);
    if (!explicitYear && parsed <= now) parsed = makeTimestamp(++year);
    if (Number.isFinite(parsed)) return explicitYear && parsed <= now ? now : parsed;
  }

  const resetDateTime = text.match(/\bresets?(?:\s+at)?\s+(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(?::\d{2})?)(?:\s*(Z|[+-]\d{2}:?\d{2}))?/i);
  const iso = text.match(/\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)/i);
  const timeOnly = text.match(/\bresets?(?:\s+at)?\s+(\d{1,2}):(\d{2})\b/i);
  let parsed = NaN;
  if (resetDateTime) {
    const zone = resetDateTime[3] || '';
    parsed = Date.parse(`${resetDateTime[1]}T${resetDateTime[2]}${zone}`);
  } else if (iso) {
    parsed = Date.parse(iso[1]);
  } else if (timeOnly) {
    const date = new Date(now);
    date.setHours(Number(timeOnly[1]), Number(timeOnly[2]), 0, 0);
    parsed = date.getTime();
  }
  if (Number.isFinite(parsed)) {
    while (parsed <= now) parsed += 24 * HOUR_MS;
    return parsed;
  }
  return now + HOUR_MS;
}

export function codexCooldownRemaining(now = Date.now(), cooldownFile) {
  try {
    const state = JSON.parse(fs.readFileSync(cooldownFile || defaultCooldownFile(), 'utf8'));
    const until = Number(state?.codex?.until);
    return Number.isFinite(until) && until > now ? until - now : 0;
  } catch {
    return 0;
  }
}

export function codexHardBlockBypass(now = Date.now(), cooldownFile, opts = {}) {
  let codex = {};
  try {
    codex = JSON.parse(fs.readFileSync(cooldownFile || defaultCooldownFile(), 'utf8'))?.codex || {};
  } catch {}
  const until = Number(codex.until);
  const reason = typeof codex.reason === 'string' ? codex.reason : '';
  if (!Number.isFinite(until) || until <= now) return { bypass: false, until: 0, reason };

  let hasGemini = opts.hasGemini;
  if (hasGemini === undefined) {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    hasGemini = spawnSync(finder, ['gemini'], { stdio: 'ignore' }).status === 0;
  }
  return {
    bypass: reason === 'usage_limit_no_fallback' || hasGemini === false,
    until,
    reason,
  };
}

export function writeCodexCooldown(until, cooldownFile, reason = 'usage_limit') {
  const file = cooldownFile || defaultCooldownFile();
  let state = {};
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  if (!state || typeof state !== 'object' || Array.isArray(state)) state = {};
  const at = Date.now();
  state.codex = { until: Number(until), reason, at };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}
