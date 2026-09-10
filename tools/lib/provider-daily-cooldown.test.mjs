import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDailyQuotaResponse, markDailyProviderCooldown, nextUtcMidnight } from './provider-daily-cooldown.mjs';

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
