import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { realLaneStats, applyRealLaneHealth } from './lib/lane-real-health.mjs';
import { laneDoctorQuick, laneDoctorProbe } from './lane-doctor.mjs';
const now = Date.parse('2026-10-29T12:00:00Z');
function fixture(t, rows) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-real-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/executor-usage.jsonl'), rows.map(r => JSON.stringify({ t: new Date(now - 1000).toISOString(), provider: 'deepseek', ...r })).join('\n') + '\n{partial');
  return home;
}
test('24h failures override successful probe, preserve ranking and routing', t => {
  const home = fixture(t, [...Array.from({ length: 4 }, () => ({ status: '500', reason: 'HTTP 500' })), { status: 'ok' }]);
  fs.writeFileSync(path.join(home, '.claude/openrouter.env'), 'OPENROUTER_API_KEY=test-only');
  fs.writeFileSync(path.join(home, '.claude/lane-health.json'), JSON.stringify({ lanes: { deepseek: { alive: true, reason: 'probe_ok', probedAt: new Date(now - 2000).toISOString() } } }));
  const health = laneDoctorQuick({ home, now });
  assert.equal(health.lanes.deepseek.reason, 'real_fail_rate');
  assert.equal(health.lanes.deepseek.alive, false);
  assert.equal(health.lanes.deepseek.error, 'HTTP 500 (4)');
  assert.ok(!health.askOrder.includes('deepseek'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude/lane-health.json'))).lanes.deepseek.reason, 'real_fail_rate');
});
test('inclusive threshold excludes quota failures from numerator', t => {
  const home = fixture(t, [{ status: '500' }, { status: '401' }, { status: '429' }, { status: 'error', reason: 'usage_limit' }, { status: 'ok' }]);
  const s = realLaneStats(home, now).deepseek;
  assert.equal(s.calls, 5); assert.equal(s.failures, 2); assert.equal(s.failRate, .4);
  const h = { lanes: { deepseek: { alive: true, reason: 'probe_ok' } } };
  applyRealLaneHealth(h, home, now); assert.equal(h.lanes.deepseek.alive, true);
  fs.appendFileSync(path.join(home, '.claude/executor-usage.jsonl'), '\n' + JSON.stringify({ t: new Date(now).toISOString(), provider: 'deepseek', status: 'error', stderr: 'spawn sdk ENOENT' }));
  applyRealLaneHealth(h, home, now); assert.equal(h.lanes.deepseek.reason, 'real_fail_rate');
  assert.match(h.lanes.deepseek.error, /spawn sdk ENOENT/);
});
test('old, future, invalid and unrouted records cannot reach five-call threshold', t => {
  const home = fixture(t, [...Array.from({ length: 4 }, () => ({ status: '500' })), { status: '500', t: new Date(now - 86400_001).toISOString() }, { status: '500', t: new Date(now + 1).toISOString() }, { status: '500', t: 'invalid' }, { status: 'no-cheap-executor' }]);
  const h = { lanes: { deepseek: { alive: true, reason: 'probe_ok' } } };
  applyRealLaneHealth(h, home, now); assert.equal(h.lanes.deepseek.alive, true); assert.equal(h.lanes.deepseek.real24h.calls, 4);
});
test('known quota reset is quota_wait; later success invalidates ledger-only quota', t => {
  const home = fixture(t, [{ status: '429', retryAt: now + 3600_000 }]);
  const h = { lanes: { deepseek: { alive: true, reason: 'probe_ok' } } };
  applyRealLaneHealth(h, home, now); assert.equal(h.lanes.deepseek.reason, 'quota_wait'); assert.equal(h.lanes.deepseek.until, now + 3600_000);
  fs.appendFileSync(path.join(home, '.claude/executor-usage.jsonl'), '\n' + JSON.stringify({ t: new Date(now).toISOString(), provider: 'deepseek', status: 'ok' }));
  const fresh = { lanes: { deepseek: { alive: true, reason: 'probe_ok' } } };
  applyRealLaneHealth(fresh, home, now); assert.equal(fresh.lanes.deepseek.alive, true);
});
test('probe cannot mask real failure rate; quota probe becomes quota_wait', async t => {
  const home = fixture(t, Array.from({ length: 5 }, () => ({ status: '503' })));
  fs.writeFileSync(path.join(home, '.claude/openrouter.env'), 'OPENROUTER_API_KEY=test-only');
  let h = await laneDoctorProbe({ home, now, probe: async () => ({ code: 0, text: 'PONG' }), notify: async () => ({ delivered: 'test' }) });
  assert.equal(h.lanes.deepseek.reason, 'real_fail_rate');
  fs.writeFileSync(path.join(home, '.claude/executor-usage.jsonl'), '');
  h = await laneDoctorProbe({ home, now, probe: async () => ({ code: 1, text: 'HTTP 429 usage limit' }), notify: async () => ({ delivered: 'test' }) });
  assert.equal(h.lanes.deepseek.reason, 'quota_wait');
});
test('billing variants are excluded from failures and never block; real 500 threshold still blocks', async t => {
  const { evaluateRepairFirst } = await import('./lane-repair-first-gate.mjs');
  const { repairContext } = await import('./lib/lane-repair-state.mjs');
  const rows = ['HTTP 402', 'Insufficient Balance', 'insufficient_quota', 'credits are depleted', 'not enough credits'].map(reason => ({ status: 'error', reason }));
  const home = fixture(t, rows);
  const h = laneDoctorQuick({ home, now });
  assert.equal(h.lanes.deepseek.reason, 'billing');
  assert.equal(h.lanes.deepseek.real24h.billingCalls, 5);
  assert.equal(h.lanes.deepseek.real24h.failures, 0);
  fs.writeFileSync(path.join(home, '.claude/lane-health.json'), JSON.stringify({ lanes: { deepseek: h.lanes.deepseek } }));
  assert.equal(evaluateRepairFirst({ tool_name: 'Edit' }, { home, now }).decision, 'pass');
  assert.match(repairContext(h, home, now), /deepseek: 残高不足。代替の安いレーン/);
  assert.ok(JSON.parse(fs.readFileSync(path.join(home, '.claude/routing-overrides.json'))).demote.deepseek);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude/provider-cooldown.json'))).deepseek.reason, 'billing');
  fs.appendFileSync(path.join(home, '.claude/executor-usage.jsonl'), '\n' + Array.from({ length: 6 }, () => JSON.stringify({ t: new Date(now).toISOString(), provider: 'deepseek', status: '500' })).join('\n'));
  assert.equal(laneDoctorQuick({ home, now }).lanes.deepseek.reason, 'real_fail_rate');
  assert.equal(evaluateRepairFirst({ tool_name: 'Edit' }, { home, now }).decision, 'block');
});
test('billing quick diagnosis notification is once per lane per UTC day', async t => {
  const { notifyLaneStops } = await import('./lane-doctor.mjs');
  const home = fixture(t, [{ status: '402' }]);
  const health = laneDoctorQuick({ home, now });
  health.deadNeedsUser = []; // This test concerns billing only, independently of host Codex auth.
  const sent = [];
  const notify = async text => { sent.push(text); return { delivered: 'test' }; };
  await notifyLaneStops(health, { home, now, notify });
  await notifyLaneStops(health, { home, now: now + 1000, notify });
  assert.equal(sent.length, 1);
  assert.match(sent[0], /の deepseek が残高不足\(402\)。入金（オートチャージON）が既定/);
  await notifyLaneStops(health, { home, now: now + 12 * 3600_000, notify });
  assert.equal(sent.length, 2);
});
test('diagnosed billing cooldown skips explicit llm-ask candidate in existing fallback router', async t => {
  const { callWithFallback } = await import('./llm-fallback.mjs');
  const home = fixture(t, [{ provider: 'gemini', status: '402' }]);
  laneDoctorQuick({ home, now });
  const attempted = [];
  const result = await callWithFallback({
    start: { provider: 'gemini', model: 'test' }, chain: [{ provider: 'openrouter', model: 'test' }],
    cooldownFile: path.join(home, '.claude/provider-cooldown.json'),
    ledgerFile: path.join(home, '.claude/routing-ledger.jsonl'),
    budgetFile: path.join(home, '.claude/budget.json'), now: () => now,
    payloadFor(candidate) { attempted.push(candidate.provider); return { url: 'https://example.invalid', init: {} }; },
    fetchImpl: async () => new Response('{}', { status: 200 }),
  });
  assert.deepEqual(attempted, ['openrouter']);
  assert.equal(result.candidate.provider, 'openrouter');
});

test('real glm exhausted limit and cooldown rows are quota, never repair blockers', async t => {
  const { evaluateRepairFirst } = await import('./lane-repair-first-gate.mjs');
  const error = 'HTTP429 {"error":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-29T19:53:29Z"}';
  const home = fixture(t, [...Array.from({ length: 70 }, () => ({ provider: 'glm', status: 'cooldown' })), ...Array.from({ length: 39 }, () => ({ provider: 'glm', status: 'error', stderr: error }))]);
  const health = { lanes: { glm: { alive: false, reason: 'probe_failed', error } } };
  applyRealLaneHealth(health, home, now);
  assert.equal(health.lanes.glm.reason, 'quota_wait');
  assert.equal(health.lanes.glm.real24h.failures, 0);
  assert.equal(health.lanes.glm.until, Date.parse('2026-10-29T19:53:29Z'));
  fs.writeFileSync(path.join(home, '.claude/lane-health.json'), JSON.stringify(health));
  assert.equal(evaluateRepairFirst({ tool_name: 'Edit' }, { home, now }).decision, 'pass');
});
test('groq 429 with billing prose is quota without reset; 402 is billing', t => {
  for (const [error, reason] of [['HTTP429 billing rate limit', 'quota_wait'], ['HTTP 402 insufficient balance', 'billing']]) {
    const home = fixture(t, [{ provider: 'groq', status: 'error', stderr: error }]);
    const health = { lanes: { groq: { alive: false, reason: 'billing', error } } };
    applyRealLaneHealth(health, home, now);
    assert.equal(health.lanes.groq.reason, reason);
    assert.equal(health.lanes.groq.real24h.failures, 0);
  }
});
test('three server errors out of five still block implementation', async t => {
  const { evaluateRepairFirst } = await import('./lane-repair-first-gate.mjs');
  const home = fixture(t, [{ status: '500' }, { status: '502' }, { status: '503' }, { status: 'ok' }, { status: 'ok' }]);
  const health = { lanes: { deepseek: { alive: true } } };
  applyRealLaneHealth(health, home, now);
  assert.equal(health.lanes.deepseek.reason, 'real_fail_rate');
  fs.writeFileSync(path.join(home, '.claude/lane-health.json'), JSON.stringify(health));
  assert.equal(evaluateRepairFirst({ tool_name: 'Edit' }, { home, now }).decision, 'block');
});
test('legacy bare billing cached from 429 is corrected from ledger evidence', t => {
  const home = fixture(t, [{ provider: 'groq', status: '429' }]);
  const health = { lanes: { groq: { alive: false, reason: 'billing' } } };
  applyRealLaneHealth(health, home, now);
  assert.equal(health.lanes.groq.reason, 'quota_wait');
});
test('glm real error with limit exhausted text is quota_wait not real_fail_rate', t => {
  const error = 'HTTP429 {"error":"Weekly/Monthly Limit Exhausted. Your limit will reset at 2026-10-29T19:53:29Z"}';
  const home = fixture(t, [
    ...Array.from({ length: 70 }, () => ({ provider: 'glm', status: 'cooldown' })),
    ...Array.from({ length: 39 }, () => ({ provider: 'glm', status: 'error', stderr: error })),
  ]);
  const stats = realLaneStats(home, now);
  assert.equal(stats.glm.quotaCalls, 109);
  assert.equal(stats.glm.failures, 0);
  assert.equal(stats.glm.failRate, 0);
  const health = { lanes: { glm: { alive: false, reason: 'probe_failed', error } } };
  applyRealLaneHealth(health, home, now);
  assert.equal(health.lanes.glm.reason, 'quota_wait');
  assert.equal(health.lanes.glm.until, Date.parse('2026-10-29T19:53:29Z'));
});
test('groq 429 with billing-like prose is quota_wait, not billing', t => {
  for (const [error, expected] of [
    ['HTTP429 billing rate limit', 'quota_wait'],
    ['HTTP 429 Insufficient credits for this request', 'quota_wait'],
    ['429 rate limit exceeded', 'quota_wait'],
    ['HTTP 402 insufficient balance', 'billing'],
    ['HTTP 402 Your credits are depleted', 'billing'],
  ]) {
    const home = fixture(t, [{ provider: 'groq', status: 'error', stderr: error }]);
    const stats = realLaneStats(home, now);
    const isBilling = expected === 'billing';
    assert.equal(stats.groq.billingCalls, isBilling ? 1 : 0, `billingCalls for "${error}"`);
    assert.equal(stats.groq.quotaCalls, isBilling ? 0 : 1, `quotaCalls for "${error}"`);
    assert.equal(stats.groq.failures, 0);
    // Simulate old cached billing reason with error text: applyRealLaneHealth must reclassify.
    const health = { lanes: { groq: { alive: false, reason: 'billing', error, real24h: stats.groq } } };
    applyRealLaneHealth(health, home, now);
    assert.equal(health.lanes.groq.reason, expected, `reason for "${error}"`);
  }
});
test('five server errors out of five still produce real_fail_rate', t => {
  const home = fixture(t, Array.from({ length: 5 }, (_, i) => ({ status: ['500', '502', '503', '500', '500'][i] })));
  const health = { lanes: { deepseek: { alive: true, reason: 'probe_ok' } } };
  applyRealLaneHealth(health, home, now);
  assert.equal(health.lanes.deepseek.reason, 'real_fail_rate');
  assert.equal(health.lanes.deepseek.alive, false);
  assert.ok(health.lanes.deepseek.error.includes('HTTP 500'));
});
test('billing penalty with 429 text in same detail is ONLY quota before billing', t => {
  // The row text contains both 429-like billing prose. quotaFailure matches first.
  const home = fixture(t, [{ provider: 'groq', status: 'error', stderr: 'HTTP 429 monthly limit exceeded' }]);
  const stats = realLaneStats(home, now);
  assert.equal(stats.groq.billingCalls, 0);
  assert.equal(stats.groq.quotaCalls, 1);
  assert.equal(stats.groq.failures, 0);
});
test('billing majority outranks quota, while repairable failure rate outranks both', t => {
  const home = fixture(t, [...Array.from({ length: 14 }, () => ({ status: '402' })), { status: '429', until: now + 10000 }]);
  const h = { lanes: { deepseek: { alive: false, reason: 'quota_wait', until: now + 10000 } } };
  applyRealLaneHealth(h, home, now);
  assert.equal(h.lanes.deepseek.reason, 'billing');
  assert.equal(h.lanes.deepseek.until, undefined);
  fs.appendFileSync(path.join(home, '.claude/executor-usage.jsonl'), '\n' + Array.from({ length: 16 }, () => JSON.stringify({ provider: 'deepseek', t: now, status: '500' })).join('\n'));
  applyRealLaneHealth(h, home, now);
  assert.equal(h.lanes.deepseek.reason, 'real_fail_rate');
});
test('expired ledger and error resets do not create quota_wait', t => {
  const home = fixture(t, [{ status: '429', until: now - 1 }]);
  const h = { lanes: { deepseek: { alive: true, reason: 'probe_ok', until: now - 1 } } };
  applyRealLaneHealth(h, home, now);
  assert.equal(h.lanes.deepseek.alive, true);
  assert.equal(h.lanes.deepseek.until, undefined);
});
