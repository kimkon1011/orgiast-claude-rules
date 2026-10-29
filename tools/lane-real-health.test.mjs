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
  fs.writeFileSync(path.join(home, '.claude/deepseek.env'), 'DEEPSEEK_API_KEY=test-only');
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
  fs.writeFileSync(path.join(home, '.claude/deepseek.env'), 'DEEPSEEK_API_KEY=test-only');
  let h = await laneDoctorProbe({ home, now, probe: async () => ({ code: 0, text: 'PONG' }), notify: async () => ({ delivered: 'test' }) });
  assert.equal(h.lanes.deepseek.reason, 'real_fail_rate');
  fs.writeFileSync(path.join(home, '.claude/executor-usage.jsonl'), '');
  h = await laneDoctorProbe({ home, now, probe: async () => ({ code: 1, text: 'HTTP 429 usage limit' }), notify: async () => ({ delivered: 'test' }) });
  assert.equal(h.lanes.deepseek.reason, 'quota_wait');
});
