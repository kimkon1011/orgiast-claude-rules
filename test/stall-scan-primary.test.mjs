import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, sessionSummary } from '../tools/stall-scan.mjs';
import { detectFailedJob } from '../tools/stall-sweeper.mjs';
import { TASK_RESULTS, taskResultIsNonFailure } from '../tools/lib/scheduled-task.mjs';
import { writeJson } from '../tools/lib/stuck-dialog-state.mjs';
import { main as fleetMain } from '../tools/fleet-agent.mjs';
import { resolveEffectiveLogPath } from '../tools/cost-improve-loop.mjs';

const now = Date.parse('2026-11-24T01:00:00Z');
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stall-primary-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const put = (file, data) => writeJson(path.join(home, '.claude', file), data);
  put('stall-scan-servers.json', { servers: [] });
  put('heartbeat/stuck-dialog-watch.json', { ok: true, finishedAt: new Date(now).toISOString() });
  return { home, put, options: { home, now, platform: 'win32', label: 'test', expectations: [], taskQuery: () => [] } };
}

test('resident refusal requires running evidence; numeric codes are not confused with executor failures', () => {
  assert.equal(TASK_RESULTS.START_REFUSED, 2147946720);
  for (const code of [0, 267009]) assert.equal(taskResultIsNonFailure(code), true);
  for (const code of [2147942656, 2147946720]) {
    assert.equal(taskResultIsNonFailure(code, { state: 'Running' }), true);
    assert.equal(taskResultIsNonFailure(code, { state: 'Ready' }), false);
    assert.equal(detectFailedJob([{ taskName: 'OrgiastWindowSpawnWatch', status: code, state: 'Running', t: new Date(now).toISOString() }], now).length, 0);
    assert.equal(detectFailedJob([{ taskName: 'OrgiastWindowSpawnWatch', status: code, state: 'Ready', t: new Date(now).toISOString() }], now).length, 1);
  }
  assert.equal(detectFailedJob([{ provider: 'test', status: 267009, t: new Date(now).toISOString() }], now).length, 1);
});

test('real cadence wins over log expectation, and genuine missed execution remains visible', async t => {
  const { options } = fixture(t);
  const task = { taskName: 'OrgiastLoginHealth', status: 0, state: 'Ready', cycleMinutes: 120, t: new Date(now - 90 * 60000).toISOString(), nextRunTime: new Date(now + 30 * 60000).toISOString() };
  assert.equal((await scan({ ...options, taskQuery: () => [task] })).rows.length, 0);
  task.t = new Date(now - 5 * 3600000).toISOString();
  assert.ok((await scan({ ...options, taskQuery: () => [task] })).rows.some(r => r.kind === 'task_missed'));
});

test('rotated log or successful state prevents stale-only diagnosis; failed and stale state cannot', async t => {
  const { home, put, options } = fixture(t);
  const dir = path.join(home, '.claude', 'logs'); fs.mkdirSync(dir);
  const primary = path.join(dir, 'cost-improve-loop.log'); fs.writeFileSync(primary, 'old');
  fs.utimesSync(primary, new Date(now - 48 * 3600000), new Date(now - 48 * 3600000));
  const rotated = path.join(dir, 'cost-improve-loop.locked-20261124-072001-rad11DFE.log'); fs.writeFileSync(rotated, 'new');
  fs.utimesSync(rotated, new Date(now), new Date(now));
  const expectations = [{ log: 'cost-improve-loop.log', label: 'cost', maxAgeHours: 26 }];
  assert.equal((await scan({ ...options, expectations })).rows.length, 0);
  fs.utimesSync(rotated, new Date(now - 48 * 3600000), new Date(now - 48 * 3600000));
  put('heartbeat/cost-improve-loop.json', { ok: true, finishedAt: new Date(now).toISOString() });
  assert.equal((await scan({ ...options, expectations })).rows.length, 0);
  for (const state of [{ ok: false, finishedAt: new Date(now).toISOString() }, { ok: true, finishedAt: new Date(now - 48 * 3600000).toISOString() }, { ok: true, finishedAt: new Date(now + 60000).toISOString() }]) {
    put('heartbeat/cost-improve-loop.json', state);
    assert.ok((await scan({ ...options, expectations })).rows.some(r => r.kind === 'log_stale'));
  }
});

test('new assistant reply supersedes old resume failure; missing transcript is explicitly unverified', async t => {
  const { home, put, options } = fixture(t);
  const endedAt = new Date(now - 86400000).toISOString();
  const entry = { noProgress: 1, attempts: [{ outcome: 'error', endedAt }] };
  put('stalled-session-resume.json', { sessions: { newer: entry, missing: entry, failed: entry } });
  const project = path.join(home, '.claude', 'projects', 'sample'); fs.mkdirSync(project, { recursive: true });
  for (const id of ['newer', 'failed']) fs.writeFileSync(path.join(project, `${id}.jsonl`), JSON.stringify({ type: 'assistant', timestamp: id === 'newer' ? new Date(now).toISOString() : endedAt, message: { content: [{ type: 'text', text: 'reply' }] } }) + '\n');
  const result = await scan(options);
  assert.equal(result.rows.filter(r => r.kind === 'session_stalled').length, 1);
  assert.deepEqual(result.observations.map(r => r.kind), ['session_history', 'session_unverified']);
  // A title/mtime update must not hide the failed session.
  fs.utimesSync(path.join(project, 'failed.jsonl'), new Date(now), new Date(now));
  assert.equal((await scan(options)).rows.length, 1);
});

test('cooldown is visible as reference and excluded from stall count', async t => {
  const { home, put, options } = fixture(t);
  put('provider-cooldown.json', { codex: { until: now + 60000, reason: 'limit' } });
  const result = await scan({ ...options, save: true });
  assert.equal(result.rows.length, 0); assert.equal(result.observations[0].kind, 'cooldown');
  assert.match(sessionSummary(home, now), /停滞診断: 0件.*参考情報=1件/);
});

test('empty successful poll records heartbeat; HTTP failure records failure; health check never executes', async t => {
  const { home } = fixture(t), old = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => { if (old === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = old; });
  const heartbeat = path.join(home, '.claude', 'heartbeat', 'fleet-agent.json');
  const deps = { post: () => assert.fail('must not send'), run: () => assert.fail('must not launch'), fetch: async () => ({ ok: true, json: async () => ({ directives: [] }) }) };
  assert.deepEqual(await fleetMain(['--health-check'], deps), { ok: true, directives: 0 });
  assert.equal(JSON.parse(fs.readFileSync(heartbeat)).ok, true);
  await assert.rejects(fleetMain(['--health-check'], { ...deps, fetch: async () => ({ ok: false, status: 503 }) }), /HTTP 503/);
  assert.equal(JSON.parse(fs.readFileSync(heartbeat)).ok, false);
  await assert.rejects(fleetMain(['--health-check'], { ...deps, fetch: async () => ({ ok: true, json: async () => ({}) }) }), /missing directives/);
});

test('cost log fallback skips a locked rotated file', () => {
  const locked = 'cost-improve-loop.locked-20261124-072001-rad11DFE.log';
  const chosen = resolveEffectiveLogPath('C:/audit', { mkdirSync() {}, readdirSync: () => [locked], appendFileSync() { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); } });
  assert.match(chosen, /cost-improve-loop\.locked-/);
  assert.notEqual(path.basename(chosen), locked);
});
