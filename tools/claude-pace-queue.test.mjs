import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pickTasks,
  refillFromNewOfferings,
  markTaskDone,
  summarizeQueue,
} from './claude-pace-queue.mjs';

function baseQueue(overrides = {}) {
  return {
    requestedBy: 'test',
    updatedAt: '2026-11-27T00:00:00.000Z',
    tasks: [
      {
        id: 'Q-014-01', host: '014', priority: 1, weight: 'medium',
        title: 'ブース調査', prompt: '調査する。下書きまで。', output: 'out/a', done: '一覧',
        state: '未着手', lastRunAt: null, source: 'test',
      },
      {
        id: 'Q-014-02', host: '014', priority: 2, weight: 'small',
        title: '設計書', prompt: '設計する。', output: 'out/b', done: '設計書',
        state: '未着手', lastRunAt: null, source: 'test',
      },
      {
        id: 'Q-COM-01', host: 'common', priority: 1, weight: 'small',
        title: '事故型追記', prompt: '追記する。', output: 'out/c', done: '1行',
        state: '未着手', lastRunAt: null, source: 'test',
      },
      {
        id: 'Q-008-01', host: '008', priority: 1, weight: 'medium',
        title: 'イベント候補', prompt: 'リストを作る。', output: 'out/d', done: '表',
        state: '完了', lastRunAt: '2026-11-26T00:00:00.000Z', source: 'test',
      },
      {
        id: 'Q-011-01', host: '011', priority: 1, weight: 'medium',
        title: '実行中タスク', prompt: '実装する。', output: 'out/e', done: '差分',
        state: '実行中', lastRunAt: '2026-11-27T01:00:00.000Z', source: 'test',
      },
    ],
    newOfferings: [
      {
        id: 'N-01', rank: 1, host: '014', state: '未着手',
        title: 'Reブース販売ページ', why: '粗利', prompt: 'ページを作る。PR まで。', output: 'out/n1',
      },
      {
        id: 'N-02', rank: 2, host: '018', state: '未着手',
        title: '学会パッケージページ', why: '利益率', prompt: 'ページを作る。', output: 'out/n2',
      },
    ],
    ...overrides,
  };
}

test('014 は 014 のタスクだけ選ぶ', () => {
  const q = baseQueue();
  const { tasks, rejected } = pickTasks({ queue: q, host: '014', count: 5, now: 1 });
  assert.deepEqual(tasks.map((t) => t.id), ['Q-014-01', 'Q-014-02']);
  assert.equal(rejected.length, 0);
  assert.ok(tasks.every((t) => t.host === '014'));
});

test('000 は common も拾う', () => {
  const { tasks } = pickTasks({ queue: baseQueue(), host: '000', count: 3, now: 1 });
  assert.deepEqual(tasks.map((t) => t.id), ['Q-COM-01']);
});

test('完了済み・実行中を選ばない', () => {
  const { tasks } = pickTasks({ queue: baseQueue(), host: '008', count: 3, now: 1 });
  assert.equal(tasks.length, 0);
  const r2 = pickTasks({ queue: baseQueue(), host: '011', count: 3, now: 1 });
  assert.equal(r2.tasks.length, 0);
});

test('priority 昇順 → id 昇順で選ぶ', () => {
  const queue = baseQueue({
    tasks: [
      { id: 'Q-014-09', host: '014', priority: 2, title: 'b', prompt: 'x', state: '未着手' },
      { id: 'Q-014-08', host: '014', priority: 1, title: 'a', prompt: 'x', state: '未着手' },
      { id: 'Q-014-07', host: '014', priority: 1, title: 'c', prompt: 'x', state: '未着手' },
    ],
  });
  const { tasks } = pickTasks({ queue, host: '014', count: 2, now: Date.parse('2026-11-27T12:00:00.000Z') });
  assert.deepEqual(tasks.map((t) => t.id), ['Q-014-07', 'Q-014-08']);
  assert.ok(tasks.every((t) => t.state === '実行中'));
  assert.ok(tasks.every((t) => t.lastRunAt === '2026-11-27T12:00:00.000Z'));
});

test('未着手が 0 なら refillFromNewOfferings が 1 件足す', () => {
  const queue = baseQueue({
    tasks: [
      { id: 'Q-014-01', host: '014', priority: 1, title: 'done', prompt: 'x', state: '完了' },
    ],
  });
  const { queue: next, added } = refillFromNewOfferings({ queue, host: '014', now: 1000 });
  assert.ok(added);
  assert.match(added.id, /^Q-NEW-/);
  assert.equal(added.title, 'Reブース販売ページ');
  assert.equal(next.tasks.filter((t) => t.state === '未着手').length, 1);
  assert.equal(next.newOfferings.find((o) => o.id === 'N-01').state, '着手');
});

test('社外送信を含むタスクは弾かれ rejected に入る', () => {
  const queue = baseQueue({
    tasks: [
      {
        id: 'Q-BAD-01', host: '014', priority: 1, title: '顧客へメールを送る',
        prompt: '完了後に送信する。', state: '未着手',
      },
      {
        id: 'Q-014-01', host: '014', priority: 2, title: '下書きのみ',
        prompt: 'メールは下書きまで。送信は承認経路に回す。', state: '未着手',
      },
    ],
  });
  const { tasks, rejected, queue: next } = pickTasks({ queue, host: '014', count: 5, now: 1 });
  assert.deepEqual(tasks.map((t) => t.id), ['Q-014-01']);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].id, 'Q-BAD-01');
  assert.match(rejected[0].reason, /社外送信/);
  assert.equal(next.tasks.find((t) => t.id === 'Q-BAD-01').state, '未着手');
});

test('markTaskDone が state を変える', () => {
  const q = baseQueue();
  const done = markTaskDone({ queue: q, id: 'Q-014-01', ok: true, now: 2 });
  assert.equal(done.tasks.find((t) => t.id === 'Q-014-01').state, '完了');
  const fail = markTaskDone({ queue: q, id: 'Q-014-02', ok: false, now: 3 });
  assert.equal(fail.tasks.find((t) => t.id === 'Q-014-02').state, '失敗');
  assert.equal(q.tasks.find((t) => t.id === 'Q-014-01').state, '未着手');
});

test('入力の queue を壊さない（immutability）', () => {
  const q = baseQueue();
  const snap = JSON.stringify(q);
  pickTasks({ queue: q, host: '014', count: 1, now: 9 });
  refillFromNewOfferings({
    queue: { ...q, tasks: q.tasks.map((t) => ({ ...t, state: '完了' })) },
    host: '014',
    now: 9,
  });
  markTaskDone({ queue: q, id: 'Q-014-01', ok: true, now: 9 });
  summarizeQueue(q);
  assert.equal(JSON.stringify(q), snap);
});

test('summarizeQueue が byHost と newOfferingsStarted を返す', () => {
  const q = baseQueue({
    newOfferings: [
      { id: 'N-01', rank: 1, host: '014', state: '着手', title: 'A' },
      { id: 'N-02', rank: 2, host: '018', state: '未着手', title: 'B' },
    ],
  });
  const s = summarizeQueue(q);
  assert.equal(s.byHost['014'].未着手, 2);
  assert.equal(s.byHost.common.未着手, 1);
  assert.equal(s.byHost['011'].実行中, 1);
  assert.equal(s.newOfferingsStarted.length, 1);
  assert.equal(s.newOfferingsStarted[0].id, 'N-01');
});
