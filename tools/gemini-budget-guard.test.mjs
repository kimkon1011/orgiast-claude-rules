import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { formatGeminiBudgetStatus, runGeminiBudgetGuard, summarizeGeminiBudget } from './gemini-budget-guard.mjs';
import { memoryFs } from './gemini-test-fs.mjs';

const now = new Date('2026-09-14T00:00:00Z');
const home = path.resolve('/mock-gemini-home'), dir = path.join(home, '.claude');
const row = (usd, extra = {}) => ({ t: now.toISOString(), provider: 'gemini', usd, ...extra });
const options = { now, budgetJpy: 100, usdJpy: 1 };
function fixture(rows, config = { budgetJpy: 100, usdPerJpy: 1 }, more = {}) {
  return memoryFs({ [path.join(dir, 'executor-usage.jsonl')]: rows.map(JSON.stringify).join('\n') + '\n', [path.join(dir, 'gemini-budget.json')]: JSON.stringify(config), ...more });
}
test('60 and 85 percent boundaries: 60–85 inclusive warn, >85 critical', () => {
  for (const [usd, expected] of [[59.99, 'ok'], [60, 'warn'], [84.99, 'warn'], [85, 'warn'], [85.01, 'critical']]) assert.equal(summarizeGeminiBudget([row(usd)], options).level, expected);
});
test('unmeasured >20% is unknown, exactly 20% is not', () => {
  assert.equal(summarizeGeminiBudget([row(null), ...Array.from({ length: 4 }, () => row(1))], options).level, 'ok');
  assert.equal(summarizeGeminiBudget([row(null), ...Array.from({ length: 3 }, () => row(1))], options).level, 'unknown');
  assert.equal(summarizeGeminiBudget([row(undefined, { in: 0, out: 0 })], options).unmeasuredCalls, 1);
});
test('JST month filtering, currency conversion and end-of-month pace', () => {
  const status = summarizeGeminiBudget([row(1, { t: '2026-08-31T15:00:00Z' }), row(99, { t: '2026-08-31T14:59:59Z' }), row(99, { t: '2026-09-20T00:00:00Z' }), row(99, { provider: 'groq' })], { now });
  assert.equal(status.spentUsd, 1); assert.equal(status.spentJpy, 150); assert.equal(status.paceEomJpy, 150 / 14 * 30);
});
test('unknown calls DM via existing notifier; filesystem and notifier are mocks', async () => {
  const fsImpl = fixture([row(null)]), messages = [];
  const result = await runGeminiBudgetGuard({ home, now, fsImpl, notifyImpl: async (...args) => { messages.push(args); return { delivered: 'dm' }; } });
  assert.equal(result.level, 'unknown'); assert.equal(messages.length, 1);
  assert.match(messages[0][0], /うち未計測 1 件（実費はこれより大きい）/);
  assert.deepEqual(messages[0][1], { home, webhookFallback: false });
  assert.deepEqual(JSON.parse(fsImpl.files.get(path.join(dir, 'gemini-budget-status.json'))), result);
});
test('warn notifies, ok does not; notification failure is visible', async () => {
  for (const usd of [59, 60]) {
    let sent = 0;
    await runGeminiBudgetGuard({ home, now, fsImpl: fixture([row(usd)]), notifyImpl: async () => { sent++; return { delivered: 'dm' }; } });
    assert.equal(sent, usd >= 60 ? 1 : 0);
  }
  await assert.rejects(runGeminiBudgetGuard({ home, now, fsImpl: fixture([row(null)]), notifyImpl: async () => ({ delivered: 'none' }) }), /DM未送信/);
});
test('critical merges demote with existing overrides, expiry is next month JST', async () => {
  const file = path.join(dir, 'routing-overrides.json');
  const original = { demote: { groq: '2026-09-30T00:00:00Z' }, gatewayBeforeDirect: { kimi: 'keep' }, other: { retain: true } };
  const fsImpl = fixture([row(86)], undefined, { [file]: JSON.stringify(original) });
  await runGeminiBudgetGuard({ home, now, fsImpl, notifyImpl: async () => ({ delivered: 'dm' }) });
  assert.deepEqual(JSON.parse(fsImpl.files.get(file)), { ...original, demote: { ...original.demote, gemini: '2026-09-30T15:00:00.000Z' } });
  const corrupt = fixture([row(86)], undefined, { [file]: '{broken' });
  await assert.rejects(runGeminiBudgetGuard({ home, now, fsImpl: corrupt, notifyImpl: async () => ({ delivered: 'dm' }) }));
  assert.equal(corrupt.files.get(file), '{broken');
});
test('unknown still demotes if known spending exceeds 85%', async () => {
  const fsImpl = fixture([row(86), row(null)]);
  const result = await runGeminiBudgetGuard({ home, now, fsImpl, notifyImpl: async () => ({ delivered: 'dm' }) });
  assert.equal(result.level, 'unknown'); assert.ok(fsImpl.files.has(path.join(dir, 'routing-overrides.json')));
});
test('dry-run has no filesystem writes or notifications even for critical/unknown', async () => {
  const fsImpl = fixture([row(90), row(null)]), initial = new Map(fsImpl.files);
  const result = await runGeminiBudgetGuard({ home, now, fsImpl, dryRun: true, notifyImpl: async () => { assert.fail('must not send Discord'); } });
  assert.equal(result.spentUsd, 90); assert.equal(result.level, 'unknown'); assert.deepEqual(fsImpl.files, initial); assert.deepEqual(fsImpl.writes, []);
});
test('missing/empty/corrupt ledger cannot report ok; default budget and rate are used', async () => {
  for (const fsImpl of [memoryFs(), fixture([]), fixture([], {}, { [path.join(dir, 'executor-usage.jsonl')]: 'broken\n' })]) {
    const status = await runGeminiBudgetGuard({ home, now, fsImpl, dryRun: true });
    assert.equal(status.level, 'unknown');
  }
  const status = await runGeminiBudgetGuard({ home, now, fsImpl: memoryFs(), dryRun: true });
  assert.equal(status.budgetJpy, 50000); assert.equal(status.ledgerAvailable, false);
});
test('directive always discloses unmeasured calls, missing status and stale status', () => {
  const status = summarizeGeminiBudget([row(1), row(null)], options);
  assert.match(formatGeminiBudgetStatus(status, { now }), /うち未計測 1 件（実費はこれより大きい）/);
  assert.match(formatGeminiBudgetStatus(null, { now }), /判断不能/);
  assert.match(formatGeminiBudgetStatus({ ...status, checkedAt: '2026-09-01T00:00:00Z' }, { now }), /予算状態が古い/);
});
