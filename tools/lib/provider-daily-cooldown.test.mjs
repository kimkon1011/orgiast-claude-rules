import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { activeDailyCooldown, isDailyQuotaResponse, markDailyProviderCooldown, nextUtcMidnight } from './provider-daily-cooldown.mjs';

test('daily quota patterns and long retry-after are terminal', () => {
  assert.equal(isDailyQuotaResponse(429, 'tokens per day TPD'), true);
  assert.equal(isDailyQuotaResponse(429, 'rate', 87000), true);
  assert.equal(isDailyQuotaResponse(429, 'rate', 1000), false);
});
test('groq cooldown lasts until next UTC midnight', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cooldown-'));
  const now = new Date('2026-09-10T12:00:00Z');
  const row = markDailyProviderCooldown('groq', { home, now });
  assert.equal(row.until, nextUtcMidnight(now));
  fs.rmSync(home, { recursive: true, force: true });
});

test('active cooldown is provider-specific and expires exactly at UTC midnight', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cooldown-read-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = new Date('2026-09-10T23:30:00Z');
  const row = markDailyProviderCooldown('openrouter', { home, now });
  assert.deepEqual(activeDailyCooldown('openrouter', { home, now }), row);
  assert.equal(activeDailyCooldown('groq', { home, now }), null);
  assert.deepEqual(activeDailyCooldown('openrouter', { home, now: new Date(row.until - 1) }), row);
  assert.equal(activeDailyCooldown('openrouter', { home, now: new Date(row.until) }), null);
  assert.equal(activeDailyCooldown('openrouter', { home, now: new Date(row.until + 1) }), null);
});

test('missing, unreadable, malformed and invalid cooldown files are ignored', () => {
  const now = new Date('2026-09-10T12:00:00Z');
  for (const content of ['{', 'null', '{}', '{"groq":null}', '{"groq":{}}', '{"groq":{"until":"invalid"}}', '{"groq":{"until":"9999999999999"}}']) {
    const fsImpl = { readFileSync: () => content };
    assert.equal(activeDailyCooldown('groq', { home: '/test', now, fsImpl }), null, content);
  }
  for (const code of ['ENOENT', 'EACCES']) {
    const fsImpl = { readFileSync() { throw Object.assign(new Error(code), { code }); } };
    assert.equal(activeDailyCooldown('groq', { home: '/test', now, fsImpl }), null);
  }
});
