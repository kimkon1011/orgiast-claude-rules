import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { expectedPeriodHours, auditTasks, healTasks, unresolvedTasks, runAudit, launchAudit, notifyUnresolved, main } from './unattended-job-audit.mjs';
import { listScheduledTaskDetails, enableScheduledTask, startScheduledTask } from './lib/scheduled-task.mjs';
const now = Date.parse('2026-10-18T20:00:00+09:00');
const daily = { type: 'MSFT_TaskDailyTrigger', daysInterval: 1 };
const task = (extra = {}) => ({ taskName: 'OrgiastCostImproveLoop', state: 'Ready', lastRunTime: '2026-10-17T07:20:00+09:00', lastTaskResult: 0, triggers: [daily], ...extra });
function temp(t) { const home = fs.mkdtempSync(path.join(os.tmpdir(), 'unattended-test-')); t.after(() => fs.rmSync(home, { recursive: true, force: true })); return home; }
function spawnStub(calls) { return (...args) => { calls.push(args); const child = new EventEmitter(); child.unref = () => {}; queueMicrotask(() => child.emit('spawn')); return child; }; }
test('Daily / Weekly / repetition / logon and once cadence', () => {
  assert.equal(expectedPeriodHours([daily]), 24);
  assert.equal(expectedPeriodHours([{ ...daily, daysInterval: 2 }]), 48);
  assert.equal(expectedPeriodHours([{ type: 'MSFT_TaskWeeklyTrigger', weeksInterval: 2 }]), 336);
  assert.equal(expectedPeriodHours([{ type: 'MSFT_TaskTimeTrigger', repetition: { interval: 'PT15M' } }]), .25);
  assert.equal(expectedPeriodHours([{ type: 'MSFT_TaskLogonTrigger' }]), null);
  assert.equal(expectedPeriodHours([{ type: 'MSFT_TaskTimeTrigger' }]), null);
  assert.equal(expectedPeriodHours([{ ...daily, enabled: false }]), null);
});
test('CostImproveLoop fixture: formula is 37h; 36h override detects missed run at 20:00', () => {
  assert.deepEqual(auditTasks([task()], {}, now), []);
  assert.equal(auditTasks([task()], { OrgiastCostImproveLoop: { maxAgeHours: 36 } }, now)[0].kind, 'missed');
  assert.equal(auditTasks([task()], {}, now + 3600000)[0].kind, 'missed');
});
test('missed never-run, failed codes, MorningBatch interrupted is not failed', () => {
  assert.equal(auditTasks([task({ lastRunTime: '1999-01-01' })], {}, now)[0].kind, 'missed');
  assert.equal(auditTasks([task({ lastTaskResult: 1 })], {}, now)[0].kind, 'failed');
  for (const lastTaskResult of [0, 267009, 267011, 267014]) assert.deepEqual(auditTasks([task({ taskName: 'OrgiastMorningBatch', lastTaskResult })], {}, now), []);
  assert.deepEqual(auditTasks([task({ triggers: [{ type: 'MSFT_TaskLogonTrigger' }], lastTaskResult: 1 })], {}, now), []);
});
test('disabled / missing required and ignored optional tasks', () => {
  const opts = { required: ['OrgiastCostImproveLoop', 'OrgiastMissing'] };
  assert.deepEqual(auditTasks([task({ state: 'Disabled' })], {}, now, opts).map(f => f.kind), ['disabled_required', 'missing_required']);
  assert.deepEqual(auditTasks([task({ state: 'Disabled' })], {}, now), []);
  assert.deepEqual(auditTasks([], { OrgiastMissing: { ignore: true } }, now, { required: ['OrgiastMissing'] }), []);
  assert.deepEqual(auditTasks([task({ taskName: '\\OrgiastCostImproveLoop' })], {}, now, { required: ['OrgiastCostImproveLoop'] }), []);
});
test('artifact evidence: old and missing mtime, minimum tolerance 2h', () => {
  const overrides = { OrgiastCostImproveLoop: { artifacts: ['~/old', '~/missing', '~/fresh'] } };
  assert.equal(auditTasks([task()], overrides, now, { artifactMtimes: { '~/old': now - 38 * 3600000, '~/fresh': now } }).filter(f => f.kind === 'artifact_stale').length, 2);
  const fast = task({ triggers: [{ repetition: { interval: 'PT1M' } }], lastRunTime: new Date(now - 90 * 60000).toISOString() });
  assert.deepEqual(auditTasks([fast], {}, now), []);
});
test('healing once per day, enable then start, converge only once and catch failures', async () => {
  const calls = [], state = {};
  const options = { state, now, startScheduledTask: n => calls.push('start:' + n), enableScheduledTask: n => calls.push('enable:' + n), runConverge: () => calls.push('converge') };
  const findings = [{ name: 'a', kind: 'disabled_required' }, { name: 'a', kind: 'failed' }, { name: 'b', kind: 'missing_required' }, { name: 'c', kind: 'missing_required' }];
  await healTasks(findings, options); await healTasks(findings, options);
  assert.deepEqual(calls, ['enable:a', 'start:a', 'converge']);
  await healTasks([{ name: 'a', kind: 'failed' }], { ...options, now: now + 86400000 });
  assert.equal(calls.length, 4);
  const result = await healTasks([{ name: 'z', kind: 'failed' }], { ...options, startScheduledTask: () => { throw new Error('private'); } });
  assert.equal(result[0].error, '修復の起動に失敗'); assert.ok(state.heals.z);
});
test('next audit escalates even when the original finding disappeared; successful progress clears', () => {
  const state = { heals: { OrgiastCostImproveLoop: { at: new Date(now).toISOString(), kind: 'missed' } } };
  assert.equal(unresolvedTasks([task()], [], state, now + 1).length, 1);
  assert.equal(unresolvedTasks([task({ lastRunTime: new Date(now + 1).toISOString() })], [], state, now + 2).length, 0);
  assert.equal(unresolvedTasks([], [], state, now + 1).length, 1);
});
test('persistent repair, unresolved daily notification, recovery and dry-run', async t => {
  const home = temp(t), notifications = [], starts = [];
  let tasks = [task({ lastRunTime: '1999-01-01' })];
  const options = { home, platform: 'win32', now, required: [], overrides: {}, listTasks: () => tasks, start: n => starts.push(n), notify: async body => notifications.push(body) };
  await runAudit({ ...options, dryRun: true });
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
  await runAudit(options); assert.equal(starts.length, 1);
  await runAudit({ ...options, now: now + 60000 });
  await runAudit({ ...options, now: now + 120000 });
  assert.equal(starts.length, 1); assert.equal(notifications.length, 1);
  await runAudit({ ...options, now: now + 86460000 }); assert.equal(notifications.length, 2);
  tasks = [task({ lastRunTime: new Date(now + 86460001).toISOString() })];
  await runAudit({ ...options, now: now + 86470000 });
  assert.equal(fs.readFileSync(path.join(home, '.claude/unattended-job-audit-last.txt'), 'utf8'), '');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude/unattended-job-audit-state.json'))).heals.OrgiastCostImproveLoop.resolved, true);
  tasks = [task({ lastTaskResult: 1, lastRunTime: new Date(now + 86460001).toISOString() })];
  await runAudit({ ...options, now: now + 86480000 });
  assert.equal(starts.length, 2, 'recovery must not reset the daily repair guard');
});
test('unsupported platform and failed PowerShell are safe; quiet/json output', async t => {
  assert.equal((await runAudit({ platform: 'linux', listTasks: () => assert.fail() })).skip, 'unsupported platform');
  const r = await runAudit({ home: temp(t), platform: 'win32', listTasks: () => { throw new Error('secret'); } });
  assert.deepEqual(r.lines, ['無人ジョブ監査: 計測不能']);
  const lines = [], old = console.log; console.log = s => lines.push(s);
  try { await main(['--quiet'], { platform: 'linux' }); await main(['--json'], { platform: 'linux' }); } finally { console.log = old; }
  assert.equal(lines[0], 'skip: unsupported platform'); assert.equal(JSON.parse(lines[1]).skip, 'unsupported platform');
});
test('details use one PowerShell call; enabling suppresses CIM output; folder selectors', () => {
  const commands = [];
  const spawnImpl = (exe, args) => { commands.push(args.at(-1)); return { status: 0, stdout: commands.length === 1 ? JSON.stringify([task()]) : '' }; };
  assert.equal(listScheduledTaskDetails({ spawnImpl }).length, 1);
  assert.match(commands[0], /CimClassName/); assert.match(commands[0], /StartWhenAvailable/);
  enableScheduledTask('\\Folder\\Task', { spawnImpl }); startScheduledTask('\\Folder\\Task', { spawnImpl });
  assert.match(commands[1], /Out-Null/); assert.match(commands[2], /-TaskName 'Task' -TaskPath '\\Folder\\'/);
  assert.throws(() => listScheduledTaskDetails({ spawnImpl: () => ({ status: 1, stderr: 'failure' }) }));
});
test('shared guard enforces 6h and 24h launch intervals', t => {
  const home = temp(t), calls = [], options = { home, platform: 'win32', now, spawnImpl: spawnStub(calls) };
  assert.equal(launchAudit(options), true);
  assert.equal(launchAudit({ ...options, now: now + 5 * 3600000 }), false);
  assert.equal(launchAudit({ ...options, intervalHours: 24, now: now + 7 * 3600000 }), false);
  assert.equal(launchAudit({ ...options, now: now + 6 * 3600000 }), true);
  assert.equal(calls.length, 2); assert.ok(calls[0][1].includes('--quiet'));
});
test('notification DM success and missing-token / thrown DM fallback use fleet mail', async t => {
  const home = temp(t), calls = [], spawnImpl = spawnStub(calls);
  await notifyUnresolved('test', { home, spawnImpl, notify: async () => ({ delivered: 'dm' }) }); assert.equal(calls.length, 0);
  for (const notify of [async () => ({ delivered: 'none' }), async () => { throw Error('offline'); }]) await notifyUnresolved('body', { home, spawnImpl, notify });
  assert.equal(calls.length, 2);
  for (const [, args] of calls) { assert.ok(args.includes('kim-PC')); const file = args[args.indexOf('--body-file') + 1]; assert.equal(fs.readFileSync(file, 'utf8'), 'body'); fs.rmSync(path.dirname(file), { recursive: true }); }
});
