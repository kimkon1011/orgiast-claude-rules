import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { fetchClaudePlanUsage, formatClaudePlanUsage, parseRetryAfter } from './claude-plan-usage.mjs';
function home(t) { const h = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-')); t.after(() => fs.rmSync(h, { recursive: true, force: true })); fs.mkdirSync(path.join(h, '.claude')); fs.writeFileSync(path.join(h, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'secret' } })); return h; }
test('parseRetryAfter parses numeric seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('120'), 120);
  assert.equal(parseRetryAfter(null), null);
  const now = 100000;
  const futureDate = new Date(now + 60000).toUTCString();
  assert.equal(parseRetryAfter(futureDate, now), 60);
});
test('plan usage 429 parses retry-after header', async (t) => {
  const res = await fetchClaudePlanUsage({
    home: home(t),
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: new Map([['retry-after', '120']]),
    }),
  });
  assert.deepEqual(res, { available: false, reason: 'HTTP 429', retryAfterSeconds: 120 });
});
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
