import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dailyLaneHealth } from './fleet-mail.mjs';
import { runLaneHealthWatch, buildReport } from './fleet-lane-health-report.mjs';
import { deadLanes, repairAdvice, buildLaneHealthMail, parseLaneHealthMail, parseLaneDoctorOutput } from './lib/lane-health.mjs';

function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-health-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const prev = process.env.FLEET_NO_SELF_HEAL;
test.before(() => { delete process.env.FLEET_NO_SELF_HEAL; });
test.after(() => { if (prev !== undefined) process.env.FLEET_NO_SELF_HEAL = prev; });
const health = lanes => JSON.stringify({ ts: 'x', lanes, errors: [] });
const alive = { alive: true, reason: 'probe_ok' };
function fakeRepo(t) {
  const repo = tmp(t); fs.mkdirSync(path.join(repo, 'tools'));
  fs.writeFileSync(path.join(repo, 'tools', 'lane-doctor.mjs'), ''); fs.writeFileSync(path.join(repo, 'tools', 'fleet-fix-now.ps1'), '');
  return repo;
}
const run = (t, lanes, extra = {}) => {
  const dir = extra.dir ?? tmp(t), repo = extra.repo ?? fakeRepo(t), sent = [], launched = [], spawns = [];
  const base = { dir, label: extra.label ?? 'nishi-PC', repo, platform: 'win32', now: extra.now ?? (() => Date.parse('2026-10-15T12:00:00Z')),
    spawnSyncImpl: (cmd, args, opts) => { spawns.push({ cmd, args, opts }); return { status: 0, stdout: `noise\n${health(lanes)}\n` }; },
    launch: (file, args) => launched.push({ file, args }), request: async (kind, payload) => { sent.push({ kind, payload }); return { ok: true }; } };
  return { dir, repo, sent, launched, spawns, call: o => dailyLaneHealth({ ...base, ...o }) };
};

test('deadLanes: codex は常に、他は未設定以外の停止だけ', () => {
  const h = { lanes: { codex: { alive: false, reason: 'dead:oauth_consent' }, gemini: alive, glm: { alive: false, reason: 'missing_key' }, deepseek: { alive: false, reason: 'auth_invalid' }, 'gemini-cli': { alive: false, reason: 'cli_missing' } } };
  assert.deepEqual(deadLanes(h), [{ lane: 'codex', reason: 'dead:oauth_consent' }, { lane: 'deepseek', reason: 'auth_invalid' }]);
  assert.deepEqual(deadLanes({ lanes: { codex: alive } }), []);
  assert.deepEqual(parseLaneDoctorOutput(`log\n${health({ codex: alive })}`).lanes.codex, alive);
});

test('dead があれば kim-PC へ [lane-health] note を送り fix-now -NoLogin を起動する', async t => {
  const r = run(t, { codex: { alive: false, reason: 'dead:oauth_consent' }, gemini: alive });
  const result = await r.call();
  assert.equal(r.sent.length, 1);
  const { payload } = r.sent[0];
  assert.equal(r.sent[0].kind, 'mail-send'); assert.equal(payload.to, 'kim-PC'); assert.equal(payload.messageKind, 'note');
  assert.equal(payload.why, '[lane-health] nishi-PC codex dead: dead:oauth_consent');
  assert.ok(r.spawns[0].args.includes('--probe') && r.spawns[0].args.includes('--json') && r.spawns[0].opts.windowsHide === true);
  assert.equal(r.launched.length, 1); assert.ok(r.launched[0].args.includes('-NoLogin'));
  assert.equal(result.autoFix, 'launched');
  assert.equal(parseLaneHealthMail({ ...payload, createdAt: 'c' }).autoFix, 'launched');
});

test('全部生きていれば送らない・起動しない', async t => {
  const r = run(t, { codex: alive, gemini: alive });
  assert.deepEqual(await r.call(), { healthy: true });
  assert.equal(r.sent.length, 0); assert.equal(r.launched.length, 0);
});

test('1日1回・同内容24時間抑止・復旧通知は1回', async t => {
  const dir = tmp(t), repo = fakeRepo(t); let ms = Date.parse('2026-10-15T01:00:00Z');
  const dead = run(t, { codex: { alive: false, reason: 'probe_failed' } }, { dir, repo, now: () => ms });
  await dead.call(); assert.deepEqual(await dead.call(), { skipped: 'today' });
  ms = Date.parse('2026-10-16T00:30:00Z'); // 翌日・23.5h後 → 同内容は抑止
  assert.deepEqual(await dead.call(), { skipped: 'dedupe' });
  ms = Date.parse('2026-10-17T01:00:00Z'); await dead.call(); assert.equal(dead.sent.length, 2);
  ms = Date.parse('2026-10-18T01:00:00Z');
  const ok = run(t, { codex: alive }, { dir, repo, now: () => ms });
  await ok.call(); assert.match(ok.sent[0].payload.why, /recovered/);
  ms = Date.parse('2026-10-19T01:00:00Z'); assert.deepEqual(await ok.call(), { healthy: true }); assert.equal(ok.sent.length, 1);
});

test('FLEET_NO_SELF_HEAL=1 で無効、kim-PC 自身は mail を送らない、人の操作だけの理由は fix-now を起動しない', async t => {
  process.env.FLEET_NO_SELF_HEAL = '1';
  try { assert.deepEqual(await run(t, { codex: alive }).call(), { skipped: 'disabled' }); } finally { delete process.env.FLEET_NO_SELF_HEAL; }
  const self = run(t, { codex: { alive: false, reason: 'dead:payment_required' } }, { label: 'kim-PC' });
  await self.call(); assert.equal(self.sent.length, 0); assert.equal(self.launched.length, 0);
});

test('repairAdvice: 自動修復と人の操作の区別', () => {
  assert.equal(repairAdvice('codex', 'native_failed:wsl').auto, true);
  assert.equal(repairAdvice('codex', 'dead:oauth_consent').auto, false);
  assert.equal(repairAdvice('gemini', 'probe_failed:stale').silent, true);
  assert.equal(repairAdvice('gemini', 'probe_failed:stale').human, null);
  assert.equal(repairAdvice('gemini', 'auth_invalid').auto, false);
  assert.equal(repairAdvice('codex', 'dead:oauth_consent').fixNow, true);
  assert.match(repairAdvice('codex', 'dead:physical_operation').human, /wsl/);
  assert.equal(repairAdvice('deepseek', 'dead:payment_required').fixNow, false);
});

function mailFor(pc, dead, at, extra = {}) {
  const { why, body } = buildLaneHealthMail({ pc, dead, at, recovered: !dead.length, ...extra });
  return { id: `mail-${pc}-${at}`, why, body, createdAt: at };
}
test('集計表: PC×レーン×状態×理由×推奨対処、最新報告のみ、recovered は消える、DMは1件1回', async t => {
  const home = tmp(t); fs.mkdirSync(path.join(home, '.claude'));
  const now = () => Date.parse('2026-10-15T13:00:00Z');
  const mails = [
    mailFor('nishi-PC', [{ lane: 'codex', reason: 'dead:oauth_consent' }], '2026-10-15T10:00:00Z', { autoFix: 'launched' }),
    mailFor('cr-PC', [{ lane: 'codex', reason: 'probe_failed' }], '2026-10-14T10:00:00Z'),
    mailFor('cr-PC', [], '2026-10-15T11:00:00Z'),
    mailFor('w018-PC', [{ lane: 'codex', reason: 'probe_failed' }], '2026-10-15T09:00:00Z', { autoFix: 'launched' }),
    mailFor('cafe015-PC', [{ lane: 'codex', reason: 'dead:oauth_consent' }], '2026-10-01T09:00:00Z'),
    { id: 'x', why: '無関係', body: '', createdAt: '2026-10-15T09:00:00Z' },
  ];
  const pcMap = { 'nishi-PC': { codexAccount: 'nishi@orgiast.jp' }, _codexAccountDefault: 'seisaku-team@orgiast.jp' };
  const readInboxImpl = () => mails;
  const { rows, table } = buildReport({ home, now, selfLabel: 'kim-PC', pcMap, readInboxImpl });
  assert.deepEqual(rows.map(r => `${r.pc}/${r.lane}`).sort(), ['nishi-PC/codex', 'w018-PC/codex']);
  assert.match(table, /\| PC \| レーン \| 状態 \| 理由 \| 推奨対処 \|/);
  assert.match(table, /\| nishi-PC \| codex \| dead \| dead:oauth_consent \| 人の操作が要る: .*OAuth/);
  assert.match(table, /\| w018-PC \| codex \| dead \| probe_failed \| 自動修復済み/);
  const dms = [];
  const notify = async text => { dms.push(text); return { delivered: 'dm' }; };
  const first = await runLaneHealthWatch({ home, now, notify, selfLabel: 'kim-PC', pcMap, readInboxImpl });
  assert.equal(first.notified.length, 2); assert.equal(dms.length, 2);
  const nishi = dms.find(d => d.startsWith('nishi-PC'));
  assert.match(nishi, /nishi@orgiast\.jp/); assert.match(nishi, /nishi-PC に接続/);
  assert.match(dms.find(d => d.startsWith('w018-PC')), /操作は不要/);
  await runLaneHealthWatch({ home, now, notify, selfLabel: 'kim-PC', pcMap, readInboxImpl });
  assert.equal(dms.length, 2); // 1件1回
  await runLaneHealthWatch({ home, now, notify, selfLabel: 'kim-PC', pcMap, readInboxImpl: () => [] });
  await runLaneHealthWatch({ home, now, notify, selfLabel: 'kim-PC', pcMap, readInboxImpl });
  assert.equal(dms.length, 4); // 解消後の再発は再通知
});

test('配信失敗(delivered:none)は未通知のまま残り次回再試行する', async t => {
  const home = tmp(t); fs.mkdirSync(path.join(home, '.claude'));
  const readInboxImpl = () => [mailFor('cr-PC', [{ lane: 'codex', reason: 'dead:oauth_consent' }], '2026-10-15T10:00:00Z')];
  const now = () => Date.parse('2026-10-15T13:00:00Z'); let n = 0;
  const notify = async () => ({ delivered: n++ ? 'dm' : 'none' });
  assert.equal((await runLaneHealthWatch({ home, now, notify, selfLabel: 'kim-PC', pcMap: {}, readInboxImpl })).notified.length, 0);
  assert.equal((await runLaneHealthWatch({ home, now, notify, selfLabel: 'kim-PC', pcMap: {}, readInboxImpl })).notified.length, 1);
});

test('probe起動失敗は当日済みにせず次回再試行する', async t => {
  const r = run(t, { codex: alive });
  assert.deepEqual(await r.call({ spawnSyncImpl: () => ({ status: null, error: new Error('timeout'), stdout: '' }) }), { skipped: 'probe-failed' });
  assert.equal(fs.existsSync(path.join(r.dir, '.fleet-lane-health-day')), false);
  assert.deepEqual(await r.call(), { healthy: true });
});
test('同日でもstaleがあればprobeを再実行する', async t => {
  const r = run(t, { codex: alive });
  await r.call();
  fs.writeFileSync(path.join(r.dir, 'lane-health.json'), JSON.stringify({ lanes: { codex: { alive: false, reason: 'probe_failed:stale' } } }));
  assert.deepEqual(await r.call(), { healthy: true });
  assert.equal(r.spawns.length, 2);
  assert.equal(r.spawns[1].opts.env.ORGIAST_HOME, path.dirname(r.dir));
});
