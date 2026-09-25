import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLLECTIONS, createEmptyData, normalizeData, parseData, upsertItem,
  removeItem, validateItem, taskStats, goalStats, expenseStats, leaveStats,
  profileCompleteness, dueLabel, toMarkdown,
} from '../my-page-core.mjs';

const today = '2026-09-26';

test('createEmptyData returns independent objects with empty collections', () => {
  const first = createEmptyData();
  const second = createEmptyData();
  assert.notStrictEqual(first, second);
  assert.notStrictEqual(first.profile, second.profile);
  assert.equal(first.version, 1);
  for (const collection of COLLECTIONS) {
    assert.deepEqual(first[collection], []);
    assert.deepEqual(second[collection], []);
    assert.notStrictEqual(first[collection], second[collection]);
  }
  for (const key of ['skills', 'qualifications']) {
    assert.deepEqual(first.profile[key], []);
    assert.notStrictEqual(first.profile[key], second.profile[key]);
  }
  first.tasks.push({ title: 'first only' });
  first.profile.skills.push('JavaScript');
  assert.deepEqual(second, createEmptyData());
});

test('normalizeData tolerates null, arrays and non-record inputs', () => {
  for (const raw of [null, [], [1], undefined, 42, true, 'data']) {
    assert.deepEqual(normalizeData(raw), createEmptyData());
  }
});

test('normalizeData repairs types, removes unknown keys and resolves duplicate IDs', () => {
  const raw = {
    unknown: 'discard', version: 99, updatedAt: 123,
    profile: { name: 123, joinedAt: '2026-02-30', skills: [' JS ', '', null, '  '], qualifications: 'invalid', unknown: true },
    goals: [{ id: 'g', title: 123, progress: 150, status: 'invalid' }],
    tasks: [null, [], 42, { id: 'same', title: 'A', priority: 'invalid', status: 'invalid', dueDate: '2026/09/26', unknown: true },
      { id: 'same', title: 'B' }, { id: 'tasks-1', title: 'C' }, { title: 'D' }],
    leaves: 'invalid', expenses: [{ id: 'e', amount: -10 }], oneOnOnes: {},
  };
  const snapshot = structuredClone(raw);
  const result = normalizeData(raw);
  assert.equal(result.version, 1);
  assert.equal(result.updatedAt, '');
  assert.equal(Object.hasOwn(result, 'unknown'), false);
  assert.equal(Object.hasOwn(result.profile, 'unknown'), false);
  assert.equal(result.profile.name, '');
  assert.equal(result.profile.joinedAt, '');
  assert.deepEqual(result.profile.skills, ['JS']);
  assert.deepEqual(result.profile.qualifications, []);
  assert.equal(result.goals[0].title, '');
  assert.equal(result.goals[0].progress, 100);
  assert.equal(result.goals[0].status, 'planned');
  assert.deepEqual(result.tasks.map(t => t.id), ['same', 'tasks-2', 'tasks-1', 'tasks-3']);
  assert.equal(result.tasks[0].priority, 'middle');
  assert.equal(result.tasks[0].status, 'todo');
  assert.equal(result.tasks[0].dueDate, '');
  assert.equal(Object.hasOwn(result.tasks[0], 'unknown'), false);
  assert.deepEqual(result.leaves, []);
  assert.deepEqual(result.oneOnOnes, []);
  assert.equal(result.expenses[0].amount, 0);
  assert.deepEqual(normalizeData({ profile: [] }).profile, createEmptyData().profile);
  assert.deepEqual(raw, snapshot);
});

test('parseData recovers broken JSON as empty data', () => {
  assert.deepEqual(parseData('{"tasks":'), { data: createEmptyData(), recovered: true });
});

test('parseData accepts valid JSON and normalizes its contents', () => {
  const raw = { version: 1, tasks: [{ id: 't', title: 'Task' }] };
  assert.deepEqual(parseData(JSON.stringify(raw)), { data: normalizeData(raw), recovered: false });
});

test('upsertItem generates an ID, replaces matching IDs and preserves its inputs', () => {
  const original = createEmptyData();
  const snapshot = structuredClone(original);
  const item = { title: 'New task' };
  const added = upsertItem(original, 'tasks', item, 'first update');
  assert.equal(added.tasks.length, 1);
  assert.equal(typeof added.tasks[0].id, 'string');
  assert.ok(added.tasks[0].id.trim());
  assert.equal(added.tasks[0].title, 'New task');
  assert.equal(added.updatedAt, 'first update');
  assert.deepEqual(original, snapshot);
  assert.deepEqual(item, { title: 'New task' });
  const addedSnapshot = structuredClone(added);
  const replacement = { id: added.tasks[0].id, title: 'Replaced task', status: 'done' };
  const replaced = upsertItem(added, 'tasks', replacement, 'second update');
  assert.equal(replaced.tasks.length, 1);
  assert.equal(replaced.tasks[0].id, replacement.id);
  assert.equal(replaced.tasks[0].title, replacement.title);
  assert.equal(replaced.tasks[0].status, 'done');
  assert.equal(replaced.updatedAt, 'second update');
  assert.deepEqual(added, addedSnapshot);
});

test('upsertItem rejects unknown collections', () => {
  assert.throws(() => upsertItem(createEmptyData(), 'unknown', { id: 'x' }), RangeError);
});

test('removeItem removes only the matching item without mutating data', () => {
  const original = normalizeData({ tasks: [{ id: 'a', title: 'A' }, { id: 'b', title: 'B' }], goals: [{ id: 'a', title: 'Goal' }] });
  const snapshot = structuredClone(original);
  const result = removeItem(original, 'tasks', 'a');
  assert.deepEqual(result.tasks, [original.tasks[1]]);
  assert.deepEqual(result.goals, original.goals);
  assert.deepEqual(original, snapshot);
  assert.deepEqual(removeItem(original, 'tasks', 'absent'), original);
});

test('validateItem rejects missing required fields, bad dates and negative amounts', () => {
  for (const collection of COLLECTIONS) {
    const result = validateItem(collection, {});
    assert.equal(result.ok, false, collection);
    assert.ok(result.errors.length > 0);
  }
  for (const dueDate of ['2026/09/26', '2026-02-30']) {
    assert.equal(validateItem('tasks', { title: 'Task', dueDate }).ok, false);
  }
  assert.equal(validateItem('expenses', { item: 'Travel', amount: -1 }).ok, false);
  assert.deepEqual(validateItem('expenses', { item: 'Travel', amount: 0, date: today }), { ok: true, errors: [] });
  assert.deepEqual(validateItem('tasks', { title: 'Task', dueDate: today }), { ok: true, errors: [] });
});

test('taskStats counts today and day seven as dueSoon, excluding done tasks', () => {
  const tasks = [
    { status: 'todo', dueDate: '2026-09-25' },
    { status: 'todo', dueDate: today },
    { status: 'doing', dueDate: '2026-10-03' },
    { status: 'doing', dueDate: '2026-10-04' },
    { status: 'done', dueDate: '2026-09-25' },
    { status: 'done', dueDate: today },
    { status: 'done', dueDate: '2026-10-03' },
    { status: 'todo', dueDate: '' },
  ];
  assert.deepEqual(taskStats(tasks, today), { total: 8, todo: 3, doing: 2, done: 3, overdue: 1, dueSoon: 2 });
});

test('goalStats returns zero for no goals and rounds averages to one decimal', () => {
  assert.deepEqual(goalStats([]), { total: 0, planned: 0, active: 0, achieved: 0, dropped: 0, averageProgress: 0 });
  assert.deepEqual(goalStats([
    { status: 'planned', progress: 0 }, { status: 'active', progress: 0 }, { status: 'achieved', progress: 2 },
  ]), { total: 3, planned: 1, active: 1, achieved: 1, dropped: 0, averageProgress: 0.7 });
  assert.equal(goalStats([{ progress: 0 }, { progress: 0 }, { progress: 1 }]).averageProgress, 0.3);
});

test('expenseStats counts only draft and submitted amounts as pending', () => {
  assert.deepEqual(expenseStats([
    { status: 'draft', amount: 100 }, { status: 'submitted', amount: 200 },
    { status: 'approved', amount: 400 }, { status: 'rejected', amount: 800 },
  ]), { count: 4, totalAmount: 1500, pendingCount: 2, pendingAmount: 300, approvedAmount: 400, rejectedCount: 1 });
});

test('leaveStats filters by year, counts types and allows negative remaining days', () => {
  assert.deepEqual(leaveStats([
    { date: '2025-12-31', type: 'paid' }, { date: '2027-01-01', type: 'paid' },
    { date: '2026-02-30', type: 'paid' }, { date: '2026-01-01', type: 'paid' },
    { date: today, type: 'substitute' }, { date: '2026-10-01', type: 'special' },
    { date: '2026-10-02', type: 'other' }, { date: '2026-10-03', type: 'unknown' },
  ], 2026, 2, today), {
    usedDays: 3, plannedDays: 4, remainingDays: -1,
    byType: { paid: 1, substitute: 1, special: 1, other: 2 },
  });
});

test('profileCompleteness reports filled fields, rounded percent and missing keys', () => {
  const keys = ['name', 'kana', 'department', 'role', 'joinedAt', 'email', 'phone', 'location', 'employeeId', 'skills', 'qualifications'];
  assert.deepEqual(profileCompleteness(null), { filled: 0, total: 11, percent: 0, missing: keys });
  assert.deepEqual(profileCompleteness({ name: 'Kim', skills: ['JS'], role: '  ', qualifications: [] }), {
    filled: 2, total: 11, percent: 18, missing: keys.filter(k => k !== 'name' && k !== 'skills'),
  });
  const full = Object.fromEntries(keys.map(k => [k, ['skills', 'qualifications'].includes(k) ? ['value'] : 'value']));
  assert.deepEqual(profileCompleteness(full), { filled: 11, total: 11, percent: 100, missing: [] });
});

test('dueLabel covers all five branches and the seven-day boundary', () => {
  for (const [date, expected] of [
    ['', 'none'], ['2026-02-30', 'none'], ['2026-09-25', 'overdue'],
    [today, 'today'], ['2026-09-27', 'soon'], ['2026-10-03', 'soon'], ['2026-10-04', 'later'],
  ]) assert.equal(dueLabel(date, today), expected, date);
  assert.equal(dueLabel(today, 'invalid'), 'none');
});

test('toMarkdown emits every heading for empty data', () => {
  const markdown = toMarkdown(createEmptyData(), today);
  assert.deepEqual(markdown.split('\n').filter(line => line.startsWith('#')), [
    '# 社員マイページ: ', '## プロフィール', '## 目標', '## タスク', '## 休暇', '## 経費', '## 1on1',
  ]);
  assert.equal(markdown.split('（登録なし）').length - 1, 5);
});

test('toMarkdown marks overdue task deadlines', () => {
  const data = normalizeData({ tasks: [
    { id: 'late', title: 'Overdue task', status: 'todo', dueDate: '2026-09-25' },
    { id: 'future', title: 'Future task', status: 'todo', dueDate: '2026-10-04' },
  ] });
  const markdown = toMarkdown(data, today);
  const overdueRow = markdown.split('\n').find(line => line.includes('Overdue task'));
  const futureRow = markdown.split('\n').find(line => line.includes('Future task'));
  assert.ok(overdueRow.includes('⚠2026\\-09\\-25'));
  assert.ok(futureRow.includes('2026\\-10\\-04'));
  assert.equal(futureRow.includes('⚠'), false);
});
