import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from './case-goals.mjs';
import { goalsPath, loadGoals, updateGoals, writeJson, validateGoals, remainingDays, progressLine, contextGoals } from './lib/case-goals.mjs';
import { newestGoals, syncGoals } from './lib/case-goals-drive.mjs';

const id = '260430EIG';
const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'case-goals-test-'));
const initial = () => updateGoals(null, id, 'set', { metric: '課題提供企業', target: '10', deadline: '2026-12-12', source: '2026-11-18 kim「10社集める」（テスト）' });
const options = target => ['set', id, '--metric', '課題提供企業', '--target', String(target), '--deadline', '2026-12-12', '--source', '2026-11-18 kim 指示'];

test('set/progress/show/list preserve source, approvals and independent current/sent counts', async () => {
  const h = home(), output = [], syncs = [];
  const deps = { home: h, sync: async id => syncs.push(id), out: text => output.push(text) };
  await main(options(10), deps);
  await main(['progress', id, '--metric', '課題提供企業', '--current', '1', '--sent', '30'], deps);
  await main([...options(5), '--kim-approved', 'kim「今回は5社に変更してよい」2026-11-18'], deps);
  const data = loadGoals(id, h), g = data.goals[0];
  assert.equal(g.target, 5); assert.equal(g.current, 1); assert.equal(g.sent, 30);
  assert.equal(g.history.length, 2); assert.match(g.history[1].kimApproved, /5社/);
  await main(['show', id], deps); await main(['list'], deps);
  assert.match(output.at(-1), /目標 5 \/ 現状 1/); assert.equal(syncs.length, 6);
});

test('unapproved shrink CLI exits 2 before network and leaves bytes unchanged; old approval cannot be reused', () => {
  const h = home(), file = goalsPath(id, h);
  const approved = updateGoals(initial(), id, 'set', { metric: '課題提供企業', target: 8, deadline: '2026-12-12', source: 'kim', 'kim-approved': '8社に変更' });
  writeJson(file, approved); const before = fs.readFileSync(file, 'utf8');
  const result = spawnSync(process.execPath, ['tools/case-goals.mjs', ...options(1)], { env: { ...process.env, ORGIAST_HOME: h }, encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, /GOAL-SHRINK/);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('reject invalid dates, negative/missing numbers, paths and tampered histories', () => {
  for (const target of [-1, NaN, Infinity, '', 'abc', undefined]) assert.throws(() => updateGoals(null, id, 'set', { metric: '企業', target, deadline: '2026-12-12', source: 'kim' }));
  assert.throws(() => updateGoals(null, id, 'set', { metric: '企業', target: 10, deadline: '2026-02-30', source: 'kim' }));
  assert.throws(() => goalsPath('../other'));
  const tampered = initial(); tampered.goals[0].target = 1;
  assert.throws(() => validateGoals(tampered, id), /履歴/);
});

test('JST deadline includes today and required pace is numerical', () => {
  const now = Date.parse('2026-12-11T15:01:00Z');
  assert.equal(remainingDays('2026-12-12', now), 0);
  assert.match(progressLine(initial().goals[0], now), /必要ペース 10\/日/);
});

test('binding and explicit case collect all metrics; malformed GOALS is not ignored', () => {
  const h = home(); writeJson(goalsPath(id, h), initial());
  writeJson(path.join(h, '.claude/case-binding/s1.json'), { cases: [id] });
  assert.equal(contextGoals({ home: h, sessionId: 's1' }).length, 1);
  assert.equal(contextGoals({ home: h, text: `案件 ${id}` }).length, 1);
  fs.writeFileSync(goalsPath(id, h), '{broken');
  assert.throws(() => contextGoals({ home: h, caseId: id }));
});

test('immutable revision reconciliation refuses concurrent edits and deleted history', () => {
  const a = initial(), b = updateGoals(a, id, 'progress', { metric: '課題提供企業', current: 1, sent: 20 });
  const c = updateGoals(a, id, 'progress', { metric: '課題提供企業', current: 2, sent: 30 });
  assert.equal(newestGoals([a, b], id).revision, b.revision);
  assert.throws(() => newestGoals([b, c], id), /同時更新/);
  const changed = structuredClone(b); changed.goals[0].history[0].source = changed.goals[0].source = '改竄';
  assert.throws(() => newestGoals([a, changed], id), /履歴/);
});

function driveFixture() {
  const files = new Map(), calls = [], editors = [];
  let count = 0;
  const fetchImpl = async (url, options) => {
    calls.push([url, options.method || 'GET']);
    const u = new URL(url), method = options.method || 'GET';
    if (u.pathname === '/drive/v3/files') {
      const q = u.searchParams.get('q');
      if (q.includes('1RLY')) return Response.json({ files: [{ id: 'sessions', name: 'case-sessions' }] });
      if (q.includes("'sessions'")) return Response.json({ files: [{ id: 'case', name: id }] });
      return Response.json({ files: [...files].map(([id, f]) => ({ id, name: f.name })) });
    }
    if (method === 'POST') {
      const parts = options.body.split('\r\n\r\n');
      const meta = JSON.parse(parts[1].split('\r\n--')[0]), data = JSON.parse(parts[2].split('\r\n--')[0]);
      const key = `file-${++count}`; files.set(key, { name: meta.name, data }); return Response.json({ id: key });
    }
    const key = u.pathname.split('/').at(-1), file = files.get(key);
    if (!file) return new Response('', { status: 404 });
    if (method === 'PATCH') { file.data = JSON.parse(options.body); return Response.json({ id: key }); }
    return Response.json(file.data);
  };
  return { files, calls, editors, deps: { fetchImpl, ensureEditor: async id => editors.push(id) } };
}

test('Drive roundtrip to a cold seat, no-op sync, stale seat pull, then approved shrink', async () => {
  const a = home(), b = home(), drive = driveFixture();
  writeJson(goalsPath(id, a), initial());
  await syncGoals(id, { home: a, ...drive.deps });
  assert.equal(drive.files.size, 2); assert.equal(drive.editors.length, 2);
  await syncGoals(id, { home: b, ...drive.deps });
  assert.deepEqual(loadGoals(id, b), loadGoals(id, a));
  assert.equal(drive.calls.filter(([, m]) => m !== 'GET').length, 2);
  writeJson(goalsPath(id, a), updateGoals(loadGoals(id, a), id, 'set', { metric: '課題提供企業', target: 15, deadline: '2026-12-12', source: 'kim 15社' }));
  await syncGoals(id, { home: a, ...drive.deps });
  await assert.rejects(main(options(12), { home: b, sync: (id, opts) => syncGoals(id, { ...opts, ...drive.deps }), out: () => {} }), e => e.exitCode === 2);
  assert.equal(loadGoals(id, b).goals[0].target, 15);
  await main([...options(12), '--kim-approved', 'kim「12社へ変更」'], { home: b, sync: (id, opts) => syncGoals(id, { ...opts, ...drive.deps }), out: () => {} });
  await syncGoals(id, { home: a, ...drive.deps }); assert.equal(loadGoals(id, a).goals[0].target, 12);
});

test('Drive failure preserves local ledger and concurrent branches never overwrite it', async () => {
  const h = home(), a = initial(); writeJson(goalsPath(id, h), a);
  await assert.rejects(syncGoals(id, { home: h, fetchImpl: async () => new Response('', { status: 403 }) }), /403/);
  assert.deepEqual(loadGoals(id, h), a);
  const drive = driveFixture(); await syncGoals(id, { home: h, ...drive.deps });
  const remote = updateGoals(a, id, 'progress', { metric: '課題提供企業', current: 2, sent: 8 });
  drive.files.set('concurrent', { name: `GOALS.${remote.revision}.json`, data: remote });
  const local = updateGoals(a, id, 'progress', { metric: '課題提供企業', current: 1, sent: 4 });
  writeJson(goalsPath(id, h), local);
  await assert.rejects(syncGoals(id, { home: h, ...drive.deps }), /同時更新/);
  assert.deepEqual(loadGoals(id, h), local);
});
