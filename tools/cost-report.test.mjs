import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAdminCostReport } from './cost-report.mjs';
const response = (body, status = 200) => ({ ok: status === 200, status, json: async () => body });
const cost = amount => ({ data: [{ starting_at: '2026-10-16T00:00:00Z', results: [{ amount, description: 'Claude Sonnet Usage' }] }] });
const keys = [{ label: 'main', key: 'key-a' }, { label: 'SEISAKU', key: 'key-b' }];
test('two keys aggregate organizations, models and days', async () => {
  const result = await fetchAdminCostReport({ startingAt: '2026-10-01', adminKeys: keys, fetchImpl: async (url, options) => {
    const first = options.headers['x-api-key'] === 'key-a';
    return response(url.endsWith('/me') ? { id: first ? 'a' : 'b', name: first ? 'オージャスト' : 'Individual Org' } : cost(first ? '100' : '2200'));
  } });
  assert.equal(result.available, true); assert.equal(result.totalUsd, 23);
  assert.deepEqual(result.byOrg, { 'オージャスト': { totalUsd: 1, byDay: { '2026-10-16': 1 } }, 'Individual Org': { totalUsd: 22, byDay: { '2026-10-16': 22 } } });
  assert.equal(result.byModel['Claude Sonnet'], 23); assert.equal(result.byDay['2026-10-16'], 23);
});
for (const failingEndpoint of ['me', 'cost_report']) test(`one key HTTP 401 at ${failingEndpoint} preserves the other organization`, async () => {
  const result = await fetchAdminCostReport({ adminKeys: keys, fetchImpl: async (url, options) => {
    const first = options.headers['x-api-key'] === 'key-a';
    if (!first && url.includes(failingEndpoint)) return response({}, 401);
    return response(url.endsWith('/me') ? { id: first ? 'a' : 'b', name: first ? 'A' : 'B' } : cost('100'));
  } });
  assert.equal(result.available, true); assert.equal(result.totalUsd, 1); assert.equal(result.errors.length, 1);
});
test('legacy single key retains shape and pagination', async () => {
  let calls = 0;
  const result = await fetchAdminCostReport({ adminKey: 'legacy', startingAt: '2026-10-01', fetchImpl: async url => {
    assert.ok(url.includes('cost_report')); calls++;
    return response({ ...cost('100'), has_more: calls === 1, next_page: calls === 1 ? 'page 2' : null });
  } });
  assert.equal(calls, 2); assert.deepEqual(result, { available: true, totalUsd: 2, byModel: { 'Claude Sonnet': 2 }, byDay: { '2026-10-16': 2 } });
});
test('duplicate organization keys do not double count', async () => {
  const result = await fetchAdminCostReport({ adminKeys: keys, fetchImpl: async url => response(url.endsWith('/me') ? { id: 'a', name: 'A' } : cost('100')) });
  assert.equal(result.totalUsd, 1);
});
