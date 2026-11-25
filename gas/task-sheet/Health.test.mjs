import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const source = fs.readFileSync(new URL('./Health.gs', import.meta.url), 'utf8');
const context = {};
vm.createContext(context);
vm.runInContext(source.replace(/\bconst\s+/g, 'var '), context);

const headers = ['job', 'cycleMinutes', 'startedAt', 'finishedAt', 'ok', 'summary', '最終更新', '通知済み'];

test('healthPlanUpsertJob inserts a complete row', () => {
  const plan = context.healthPlanUpsertJob(headers, [], { job: 'digest', cycleMinutes: 60, finishedAt: '2026-09-03T09:00:00.000Z', ok: true }, '2026-09-03T09:01:00.000Z');
  assert.equal(plan.action, 'insert');
  assert.deepEqual(Array.from(plan.row), ['digest', 60, '', '2026-09-03T09:00:00.000Z', true, '', '2026-09-03T09:01:00.000Z', '']);
});

test('healthPlanUpsertJob preserves omitted fields and clears notification on a new report', () => {
  const rows = [['digest', '60', 'start', 'old', 'false', 'failed', 'updated', 'notified']];
  const plan = context.healthPlanUpsertJob(headers, rows, { job: 'digest', finishedAt: 'new', ok: true, summary: 'done' }, 'now');
  assert.equal(plan.action, 'update');
  assert.deepEqual(Array.from(plan.row), ['digest', '60', 'start', 'new', true, 'done', 'now', '']);
});

test('healthPlanUpsertJob keeps notification when only startedAt changes', () => {
  const rows = [['digest', '60', 'start', 'finish', 'true', 'done', 'updated', 'notified']];
  const plan = context.healthPlanUpsertJob(headers, rows, { job: 'digest', startedAt: 'new-start' }, 'now');
  assert.equal(plan.row[7], 'notified');
});

test('healthPlanUpsertJob clears notification when a report field is resubmitted unchanged', () => {
  const rows = [['digest', '60', 'start', 'finish', 'true', 'done', 'updated', 'notified']];
  const plan = context.healthPlanUpsertJob(headers, rows, { job: 'digest', finishedAt: 'finish' }, 'now');
  assert.equal(plan.row[7], '');
});

test('healthPlanScan detects false, missing, and stale reports but skips notified rows', () => {
  const rows = [
    ['failed', '60', '', '2026-09-03T09:30:00.000Z', 'false', '', '', ''],
    ['missing', '60', '', '', 'true', '', '', ''],
    ['stale', '30', '', '2026-09-03T08:00:00.000Z', 'true', '', '', ''],
    ['fresh', '60', '', '2026-09-03T09:30:00.000Z', 'true', '', '', ''],
    ['already-sent', '60', '', '', 'false', '', '', '2026-09-03T09:00:00.000Z']
  ];
  const result = context.healthPlanScan(headers, rows, '2026-09-03T10:00:00.000Z');
  assert.deepEqual(Array.from(result.alerts, alert => alert.job), ['failed', 'missing', 'stale']);
  assert.equal(result.summary.staleCount, 3);
});

test('healthPlanScan does not apply age threshold to a nonnumeric cycle', () => {
  const rows = [
    ['unknown-cycle', 'hourly', '', '2026-01-01T00:00:00.000Z', 'true', '', '', ''],
    ['empty-cycle', '', '', '2026-01-01T00:00:00.000Z', 'true', '', '', ''],
    ['bad-date', '60', '', 'not-a-date', 'true', '', '', '']
  ];
  assert.equal(context.healthPlanScan(headers, rows, '2026-09-03T10:00:00.000Z').alerts.length, 0);
});

test('healthSummaryLine formats the pinned summary', () => {
  assert.equal(context.healthSummaryLine({ summary: { staleCount: 2, checkedAt: '2026-09-03T10:00:00.000Z' } }), '健全性: 未申告ジョブ 2件 / 最終見張り 2026-09-03T10:00:00.000Z');
});
