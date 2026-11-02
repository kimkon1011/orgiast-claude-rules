import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, sweep, HOUR, acquireLock, repositories } from './stuck-pr-sweeper.mjs';
const now = Date.parse('2026-11-02T10:00:00Z');
const ago = hours => new Date(now - hours * HOUR).toISOString();
const base = () => ({ repo: 'kimkon1011/example', number: 1, title: 'repair example', url: 'https://github.com/kimkon1011/example/pull/1', state: 'OPEN', author: { login: 'kimkon1011' }, createdAt: ago(1), headRefOid: 'a'.repeat(40), statusCheckRollup: [], reviewRequests: [] });
const failure = () => ({ ...base(), statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'FAILURE', completedAt: ago(4) }] });
const config = { runner: 'kim-PC', authors: ['kimkon1011'], repositories: ['kimkon1011/example'] };
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stuck-pr-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const state = { version: 1, prs: {} }; let pr = failure(), repairs = 0, notifications = 0;
  const io = { label: 'kim-PC', readState: () => state, saveState: () => {}, list: async () => pr.state === 'OPEN' ? [pr] : [], view: async () => pr, logs: () => 'test failed',
    repair: () => { repairs++; return { exitCode: 0, result: 'attempted; CI must verify' }; }, notify: () => { notifications++; return 'notification-1'; } };
  return { state, io, home, run: (opts = {}) => sweep({ home, now, config, io, ...opts }), setPr: p => pr = p, counts: () => ({ repairs, notifications }) };
}
test('CI failure uses completion timestamp with exact 3h boundary', () => {
  const p = failure(); assert.deepEqual(classify(p, now), ['ci-failed-3h']);
  p.statusCheckRollup[0].completedAt = ago(3); assert.equal(classify(p, now).length, 1);
  p.statusCheckRollup[0].completedAt = ago(2.99); assert.deepEqual(classify(p, now), []);
  p.statusCheckRollup[0].completedAt = undefined; assert.deepEqual(classify(p, now), []);
});
test('auto-merge uses enabledAt, not creation or comments', () => {
  const p = { ...base(), autoMergeRequest: { enabledAt: ago(12) }, updatedAt: ago(0) };
  assert.deepEqual(classify(p, now), ['auto-merge-12h']);
  p.autoMergeRequest.enabledAt = ago(11.99); assert.deepEqual(classify(p, now), []);
});
test('24h OPEN excludes reviews and failures, includes hung pending CI', () => {
  const p = { ...base(), createdAt: ago(24) }; assert.deepEqual(classify(p, now), ['open-24h']);
  assert.deepEqual(classify({ ...p, reviewDecision: 'REVIEW_REQUIRED' }, now), []);
  assert.deepEqual(classify({ ...p, reviewRequests: [{ login: 'reviewer' }] }, now), []);
  assert.deepEqual(classify({ ...p, statusCheckRollup: [{ state: 'FAILURE' }] }, now), []);
  assert.deepEqual(classify({ ...p, statusCheckRollup: [{ status: 'IN_PROGRESS' }] }, now), ['open-24h']);
});
test('closed, draft and fork PRs are never repaired', () => {
  for (const extra of [{ state: 'MERGED' }, { state: 'CLOSED' }, { isDraft: true }, { isCrossRepository: true }]) assert.deepEqual(classify({ ...failure(), ...extra }, now), []);
});
test('at most two attempts across sweeps, one escalation, exit0 is not success', async t => {
  const f = fixture(t); await f.run(); await f.run(); assert.equal(f.counts().repairs, 1);
  await f.run({ now: now + 3 * HOUR }); await f.run({ now: now + 6 * HOUR }); await f.run({ now: now + 9 * HOUR });
  assert.deepEqual(f.counts(), { repairs: 2, notifications: 1 });
  assert.equal(f.state.prs['kimkon1011/example#1'].status, 'needs-user');
});
test('merging removes PR from open list and closes persisted record', async t => {
  const f = fixture(t); await f.run(); f.setPr({ ...base(), state: 'MERGED' }); await f.run();
  assert.equal(f.state.prs['kimkon1011/example#1'].status, 'merged'); assert.equal(f.counts().repairs, 1);
});
test('dry-run never writes, repairs, notifies or creates state directories', async t => {
  const f = fixture(t); f.io.saveState = () => assert.fail('write');
  const out = await f.run({ dryRun: true }); assert.equal(out.items.length, 1); assert.deepEqual(f.counts(), { repairs: 0, notifications: 0 });
  assert.deepEqual(fs.readdirSync(f.home), []);
});
test('concurrent sweep cannot duplicate an ongoing repair', async t => {
  const f = fixture(t); let finish, started;
  const entered = new Promise(r => started = r);
  f.io.repair = () => { started(); return new Promise(r => finish = r); };
  const one = f.run(); await entered;
  assert.equal((await f.run()).skipped, 'locked'); finish({ exitCode: 1 }); await one;
  assert.equal(f.state.prs['kimkon1011/example#1'].attempts.length, 1);
});
test('saved running attempt survives interruption and counts toward limit', async t => {
  const f = fixture(t); f.state.prs['kimkon1011/example#1'] = { number: 1, status: 'repairing', attempts: [{ startedAt: ago(4), status: 'running' }], reasons: ['ci-failed-3h'] };
  await f.run(); await f.run({ now: now + 3 * HOUR }); assert.deepEqual(f.counts(), { repairs: 1, notifications: 1 });
});
test('API failure never closes a record and other repositories continue', async t => {
  const f = fixture(t); await f.run(); f.io.list = () => { throw new Error('network unavailable'); };
  const out = await f.run(); assert.equal(out.errors.length, 1); assert.equal(f.state.prs['kimkon1011/example#1'].status, 'verifying');
});
test('only designated runner mutates and unrelated authors are ignored', async t => {
  const f = fixture(t); f.io.label = 'another-PC'; assert.equal((await f.run()).skipped, 'not-designated-runner');
  f.io.label = 'kim-PC'; f.setPr({ ...failure(), author: { login: 'outsider' } }); assert.equal((await f.run()).items.length, 0);
});
test('successful remote checks use merge wrapper and read back MERGED', async t => {
  const f = fixture(t); await f.run();
  const p = { ...base(), autoMergeRequest: { enabledAt: ago(13) }, mergeable: 'MERGEABLE', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] }; f.setPr(p);
  f.io.prepare = () => '/isolated'; f.io.merge = (pr, cwd) => { assert.equal(cwd, '/isolated'); f.setPr({ ...p, state: 'MERGED' }); };
  await f.run(); assert.equal(f.state.prs['kimkon1011/example#1'].status, 'merged');
});
test('existing repository catalogs extend the two mandatory repositories', () => {
  const c = repositories(); assert.ok(c.repositories.includes('kimkon1011/orgiast-memoryserve'));
  assert.ok(c.repositories.includes('kimkon1011/purchasing-management-app')); assert.equal(new Set(c.repositories).size, c.repositories.length);
});
test('active PID locks are not stolen', t => {
  const f = fixture(t), file = path.join(f.home, 'lock'); const release = acquireLock(file);
  assert.equal(acquireLock(file), null); release(); assert.equal(fs.existsSync(file), false);
});
