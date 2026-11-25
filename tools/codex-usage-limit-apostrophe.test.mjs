import test from 'node:test';
import assert from 'node:assert/strict';
import { isUsageLimitText, parseUsageLimitUntil } from './lib/executor-gate.mjs';

// 2026-10-10 nishi-PC 実測の文言（U+2019 のアポストロフィ）
const curly = 'ERROR: You\u2019ve hit your usage limit. Upgrade to Pro or try again at Oct 14th, 2026 9:53 PM.';

test('isUsageLimitText は U+2019 の You’ve も上限として検出する', () => {
  assert.equal(isUsageLimitText(curly), true);
  assert.equal(isUsageLimitText("ERROR: You've hit your usage limit."), true);
  assert.equal(isUsageLimitText('ordinary failure'), false);
});

test('parseUsageLimitUntil は U+2019 の文言から再開時刻を読む', () => {
  const now = Date.parse('2026-10-10T12:00:00Z');
  const until = parseUsageLimitUntil(curly, now);
  assert.ok(until > now, 'future reset');
  assert.ok(until - now < 6 * 24 * 3600 * 1000, 'parsed, not the 24h default only');
});
