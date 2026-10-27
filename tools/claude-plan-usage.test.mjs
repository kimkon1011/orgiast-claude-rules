import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fetchClaudePlanUsage, formatClaudePlanUsage } from './claude-plan-usage.mjs';
function home(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); fs.mkdirSync(path.join(h, '.claude')); fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'secret' } })); return h; }
test('plan usage parses utilization', async (t) => assert.deepEqual(await fetchClaudePlanUsage({ home: home(t), fetchImpl: async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 25, resets_at: 'a' }, seven_day: { utilization: 80, resets_at: 'b' } }) }) }), { available: true, fiveHour: { utilization: 25, resetsAt: 'a' }, sevenDay: { utilization: 80, resetsAt: 'b' }, scoped: [] }));
test('plan usage parses and formats scoped weekly limit', async (t) => {
  const result = await fetchClaudePlanUsage({ home: home(t), fetchImpl: async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 10 }, seven_day: { utilization: 15 }, limits: [{ kind: 'weekly_scoped', percent: 26, resets_at: 'c', is_active: true, scope: { model: { id: 'claude-fable', display_name: 'Fable' } } }] }) }) });
  assert.deepEqual(result.scoped, [{ label: 'Fable', percent: 26, resetsAt: 'c', isActive: true, kind: 'weekly_scoped' }]);
  assert.match(formatClaudePlanUsage(result), /Fable週 26%/);
});
test('plan usage without limits keeps the previous formatted output', async (t) => {
  const result = await fetchClaudePlanUsage({ home: home(t), fetchImpl: async () => ({ ok: true, json: async () => ({ five_hour: { utilization: 25 }, seven_day: { utilization: 40 } }) }) });
  assert.deepEqual(result.scoped, []);
  assert.equal(formatClaudePlanUsage(result), 'Claudeプラン上限: 5h 25.0% / 7日 40.0%');
});
test('scoped limit at 85 percent produces delegation warning', () => {
  const output = formatClaudePlanUsage({ available: true, fiveHour: { utilization: 10 }, sevenDay: { utilization: 15 }, scoped: [{ label: 'Fable', percent: 85, resetsAt: null, isActive: true, kind: 'weekly_scoped' }] });
  assert.match(output, /Fable 専用枠が先に枯れる。Fable 本体の直接作業をやめ Codex\/Sonnet へ委譲\(§1\.18\.1\)/);
});
test('plan usage 401 remains unavailable', async (t) => assert.deepEqual(await fetchClaudePlanUsage({ home: home(t), fetchImpl: async () => ({ ok: false, status: 401 }) }), { available: false, reason: 'HTTP 401' }));
test('plan usage network error remains unavailable', async (t) => { const x = await fetchClaudePlanUsage({ home: home(t), fetchImpl: async () => { throw new TypeError('offline'); } }); assert.equal(x.available, false); assert.match(x.reason, /network/); assert.equal(x.utilization, undefined); });


const usageFixture = { five_hour: { utilization: 25 }, seven_day: { utilization: 40 } };
const successResponse = () => ({ ok: true, json: async () => usageFixture });
test('a fresh reader reuses the disk cache without exposing the token', async t => {
  const h = home(t);
  await fetchClaudePlanUsage({ home: h, fetchImpl: async () => successResponse() });
  const fresh = await import('./claude-plan-usage.mjs?fresh-reader');
  const result = await fresh.fetchClaudePlanUsage({ home: h,
    fetchImpl: async () => { throw new Error('must use shared cache'); } });
  assert.equal(result.available, true);
  assert.ok(!fs.readFileSync(path.join(h, '.claude', 'claude-plan-usage-cache.json'), 'utf8').includes('secret'));
});
for (const header of ['300', 'Wed, 28 Oct 2026 00:05:00 GMT']) {
  test(`Retry-After ${header} blocks all readers until the deadline then recovers`, async t => {
    const h = home(t); let at = Date.parse('2026-10-28T00:00:00Z'), calls = 0;
    const fetchImpl = async () => { calls++; return calls === 1
      ? { ok: false, status: 429, headers: { get: () => header } } : successResponse(); };
    const read = () => fetchClaudePlanUsage({ home: h, fetchImpl, now: () => at });
    assert.equal((await read()).retryAfterMs, 300_000);
    at += 299_999;
    assert.deepEqual(await read(), { available: false, reason: 'HTTP 429', retryAfterMs: 1 });
    assert.equal(calls, 1);
    at++;
    assert.equal((await read()).available, true); assert.equal(calls, 2);
  });
}
test('success cache expires, rejects past reset windows and isolates rotated credentials', async t => {
  const h = home(t); let at = Date.now(), calls = 0;
  const fetchImpl = async () => { calls++; return successResponse(); };
  const read = () => fetchClaudePlanUsage({ home: h, fetchImpl, now: () => at });
  await read(); await read(); assert.equal(calls, 1);
  at += 15_000; await read(); assert.equal(calls, 2);
  const file = path.join(h, '.claude', 'claude-plan-usage-cache.json');
  const cached = JSON.parse(fs.readFileSync(file));
  cached.result.fiveHour.resetsAt = new Date(at - 1).toISOString();
  fs.writeFileSync(file, JSON.stringify(cached));
  await read(); assert.equal(calls, 3);
  fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'rotated' } }));
  await read(); assert.equal(calls, 4);
});
test('corrupt cache and invalid Retry-After do not prevent recovery', async t => {
  const h = home(t); const file = path.join(h, '.claude', 'claude-plan-usage-cache.json');
  fs.writeFileSync(file, '{');
  for (const header of [null, '', '-1', 'nonsense']) {
    assert.deepEqual(await fetchClaudePlanUsage({ home: h, fetchImpl: async () =>
      ({ ok: false, status: 429, headers: { get: () => header } }) }), { available: false, reason: 'HTTP 429' });
  }
  assert.equal((await fetchClaudePlanUsage({ home: h, fetchImpl: async () => successResponse() })).available, true);
});
test('overlapping readers make only one API call and a failed owner releases its lock', async t => {
  const h = home(t); let release; let calls = 0;
  const pending = fetchClaudePlanUsage({ home: h, fetchImpl: async () => {
    calls++; await new Promise(resolve => { release = resolve; }); throw new TypeError('offline');
  } });
  const other = await fetchClaudePlanUsage({ home: h, fetchImpl: async () => { calls++; return successResponse(); } });
  assert.equal(other.available, false); assert.match(other.reason, /in progress/); assert.equal(calls, 1);
  release(); assert.match((await pending).reason, /network/);
  assert.equal((await fetchClaudePlanUsage({ home: h, fetchImpl: async () => successResponse() })).available, true);
});
