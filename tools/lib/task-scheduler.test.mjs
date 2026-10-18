import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, registrationPlan, unregister } from './task-scheduler.mjs';
const spec = { name: 'demo', command: 'node x.mjs', schedule: { at: '03:00' } };

test('register dry-run honors platform without accessing schedulers', () => {
  const saved = process.env.ORGIAST_PLATFORM;
  try {
    process.env.ORGIAST_PLATFORM = 'linux';
    const linux = register(spec, { dryRun: true });
    assert.match(linux, /\[Unit\]/);
    assert.match(linux, /ExecStart=/);
    assert.match(linux, /OnCalendar=\*-\*-\* 03:00:00/);
    process.env.ORGIAST_PLATFORM = 'win32';
    const windows = register({ ...spec, dryRun: true });
    assert.match(windows, /schtasks/);
    assert.match(windows, /orgiast-demo/);
    assert.match(windows, /DAILY/);
    assert.match(unregister('demo', { dryRun: true }), /\/Delete/);
  } finally {
    if (saved === undefined) delete process.env.ORGIAST_PLATFORM;
    else process.env.ORGIAST_PLATFORM = saved;
  }
});
test('pure generation supports each schedule', () => {
  const every = { ...spec, schedule: { every: '30m' } };
  assert.match(registrationPlan(every).timer, /OnUnitActiveSec=30min/);
  assert.match(registrationPlan(every, { backend: 'cron' }).entry, /^\*\/30 /);
  assert.match(registrationPlan(spec, { backend: 'cron' }).entry, /^0 3 /);
  assert.match(registrationPlan({ ...spec, schedule: { onLogon: true } }).timer, /OnActiveSec=1s/);
  assert.match(registrationPlan({ ...spec, schedule: { onLogon: true } }, { backend: 'cron' }).entry, /^@reboot /);
  assert.ok(registrationPlan(every, { platform: 'win32' }).argv.includes('MINUTE'));
  assert.ok(registrationPlan({ ...spec, schedule: { onLogon: true } }, { platform: 'win32' }).argv.includes('ONLOGON'));
});
test('escaping preserves arguments, systemd specifiers and cron percent', () => {
  const quoted = { ...spec, args: ['space here', "it's", '$HOME', '%x', 'a"b', 'back\\slash'] };
  const plan = registrationPlan(quoted);
  assert.ok(plan.service.includes('%%x'));
  assert.ok(plan.service.includes('$$HOME'));
  assert.ok(plan.service.includes('space here'));
  assert.ok(registrationPlan(quoted, { backend: 'cron' }).entry.includes('\\%x'));
  assert.ok(registrationPlan(quoted, { platform: 'win32' }).argv.includes('/F'));
});
test('invalid schedules and unsafe names fail before side effects', () => {
  for (const schedule of [{}, { at: '25:00' }, { every: '0m' }, { every: 'x' }, { onLogon: false }, { at: '03:00', every: '30m' }]) {
    assert.throws(() => registrationPlan({ ...spec, schedule }));
  }
  assert.throws(() => registrationPlan({ ...spec, name: '../escape' }));
  assert.throws(() => registrationPlan({ ...spec, command: 'node\ninjected' }));
  assert.throws(() => registrationPlan(spec, { platform: 'darwin' }));
  assert.throws(() => registrationPlan({ ...spec, schedule: { every: '7m' } }, { backend: 'cron' }));
});
