import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, sweep, HOUR, acquireLock, repositories, notifyStuckPr } from './stuck-pr-sweeper.mjs';
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

test('repair budget is four per sweep and persists even failed invocations', async t => {
  const f = fixture(t);
  f.io.list = () => Array.from({length: 6}, (_, i) => ({...failure(),number:i+1}));
  f.io.view = (repo, number) => ({...failure(),number});
  let calls=0; f.io.repair = () => { calls++; throw new Error('worker failed'); };
  await f.run(); assert.equal(calls,4);
  assert.equal(Object.values(f.state.prs).reduce((n,r)=>n+r.attempts.length,0),4);
});
test('attempts survive reopening the real state file', async t => {
  const f=fixture(t); delete f.io.readState; delete f.io.saveState;
  await f.run(); await f.run({now:now+3*HOUR});
  const saved=JSON.parse(fs.readFileSync(path.join(f.home,'.claude/state/stuck-pr-sweeper.json'),'utf8'));
  assert.equal(saved.prs['kimkon1011/example#1'].attempts.length,2);
});
test('green checks without auto-merge never cause an automatic merge', async t => {
  const f=fixture(t); f.setPr({...base(),createdAt:ago(25),mergeable:'MERGEABLE',statusCheckRollup:[{status:'COMPLETED',conclusion:'SUCCESS'}]});
  f.io.merge=()=>assert.fail('no merge authorization'); await f.run(); assert.equal(f.counts().repairs,1);
});

for (const fallback of [false, true]) test(`real ${fallback ? 'auto-progress fallback' : 'kim-inbox'} registers once and closes after merge`, async t => {
  const f=fixture(t);
  fs.mkdirSync(path.join(f.home,'.claude'),{recursive:true});
  fs.writeFileSync(path.join(f.home,'.claude/cost-reporter.env'),'REPORTER_LABEL=kim-PC\n');
  const rec=f.state.prs['kimkon1011/example#1']={number:1,status:'verifying',reasons:['ci-failed-3h'],attempts:[{startedAt:ago(9),result:'first failed'},{startedAt:ago(4),result:'second failed'}]};
  f.io.notify=(pr,r,home)=>notifyStuckPr(pr,r,home,{inboxAvailable:!fallback});
  await f.run(); const id=rec.notificationId; assert.ok(id);
  delete rec.notificationId; await f.run(); assert.equal(rec.notificationId,id);
  if(fallback) {
    const lines=fs.readFileSync(path.join(f.home,'.claude/auto-progress-ledger.jsonl'),'utf8').trim().split('\n');assert.equal(lines.length,1);
  } else {
    assert.equal(fs.readdirSync(path.join(f.home,'.claude/kim-inbox')).filter(x=>x.endsWith('.json')).length,1);
  }
  f.setPr({...base(),state:'MERGED'});await f.run();
  if(fallback) {
    const lines=fs.readFileSync(path.join(f.home,'.claude/auto-progress-ledger.jsonl'),'utf8').trim().split('\n').map(JSON.parse);assert.equal(lines.at(-1).status,'done');assert.ok(!lines.some(x=>x.status==='waiting_user'));
  } else {
    const item=JSON.parse(fs.readFileSync(path.join(f.home,'.claude/kim-inbox',id+'.json'),'utf8'));assert.equal(item.status,'dropped');
  }
});
