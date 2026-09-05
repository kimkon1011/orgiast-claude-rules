import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MARKER, appendTodoBlock, insertTodosAtTop, isSkipped, plan, readSkip, readState, selectTasks } from './gtasks-loop.mjs';
import { parseHandoff } from './auto-session.mjs';

test('状態ファイルにある処理済み・保留タスクを除外して上から選ぶ', () => {
  const rows = [{ taskId: 'a' }, { taskId: 'b' }, { taskId: 'c' }];
  const state = { picked: { a: { status: 'picked' }, b: { status: 'hold' } } };
  assert.deepEqual(selectTasks(rows, state, 3), [rows[2]]);
  assert.deepEqual(readState('broken'), { picked: {} });
});

test('追記は既存ブロックを一字も変えずauto-sessionが読める', () => {
  const original = '前書き\r\n<!-- NEXT-SESSION v1 -->\r\n## 残TODO\r\n1. 既存\r\n';
  const changed = appendTodoBlock(original, [{ title: '新規', listId: 'L', taskId: 'T' }]);
  assert.ok(changed.startsWith(original));
  assert.match(changed, /Googleタスク消化: 新規（L\/T）/);
  assert.deepEqual(parseHandoff(changed).todos, ['既存', 'Googleタスク消化: 新規（L/T）']);
});

test('planはdry-runではファイルを書かず、通常時は追記と状態保存を行う', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtasks-loop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stateFile = path.join(dir, 'state.json');
  const nextFile = path.join(dir, 'next.md');
  fs.writeFileSync(nextFile, '<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. 元\n');
  const cache = { lists: [{ id: 'L', title: '仕事', tasks: [{ id: 'T', title: '日本語タスク' }] }] };
  const before = fs.readFileSync(nextFile, 'utf8');
  await plan({ dryRun: true, stateFile, nextFile, fetchCache: async () => cache });
  assert.equal(fs.readFileSync(nextFile, 'utf8'), before);
  assert.equal(fs.existsSync(stateFile), false);
  await plan({ stateFile, nextFile, fetchCache: async () => cache, now: () => new Date('2026-09-03T00:00:00Z') });
  const after = fs.readFileSync(nextFile, 'utf8');
  // 末尾ではなく先頭ブロックの残TODO直後に入る（既存の「1. 元」は残る）
  assert.ok(after.includes('1. Googleタスク消化: 日本語タスク（L/T）\n1. 元\n'), after);
  assert.ok(after.includes('Googleタスク消化の手順'), after);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, 'utf8')).picked.T.status, 'picked');
});

test('メモ・引用・期限切れリストは無人消化の対象から外す', () => {
  const rows = [
    { n: 1, listId: 'REs0cWdTdzcwVWpmSzJKcg', list: '古い Google Keep のリマインダー', taskId: 'k1', title: '潮干狩りにいく' },
    { n: 2, listId: 'live', list: '功勇さんのリスト', taskId: 't1', title: '私の理想がすべて現実化している' },
    { n: 3, listId: 'live', list: '功勇さんのリスト', taskId: 't2', title: '救急セットを買う' },
  ];
  const picked = selectTasks(rows, { picked: {} }, 3, readSkip(''));
  assert.deepEqual(picked.map((row) => row.taskId), ['t2']);
});

test('スキップ設定ファイルは組み込み除外に追加される', () => {
  const skip = readSkip(JSON.stringify({ titles: ['空也もなか'], listIds: ['extra'] }));
  assert.equal(isSkipped({ listId: 'live', title: '空也もなか買う' }, skip), true);
  assert.equal(isSkipped({ listId: 'extra', title: '何か' }, skip), true);
  assert.equal(isSkipped({ listId: 'live', title: '救急セットを買う' }, skip), false);
});

test('先頭ブロックの残TODO直後に差し込み、既存TODOを壊さない', () => {
  const md = [
    '# 引き継ぎ', '', MARKER, '## 次の1目的', 'なにか', '', '## 残TODO',
    '1. **既存の1件目**', '2. **既存の2件目**', '', '## 申し送り', 'メモ', '',
    MARKER, '## 残TODO', '1. **旧ブロックの1件**', '',
  ].join('\n');
  const rows = [{ listId: 'l1', taskId: 't1', title: '救急セットを買う' }];
  const out = insertTodosAtTop(md, rows);
  const lines = out.split('\n');
  assert.ok(lines[lines.indexOf('## 残TODO') + 1].includes('Googleタスク消化の手順'));
  assert.ok(lines.includes('1. Googleタスク消化: 救急セットを買う（l1/t1）'));
  assert.ok(out.includes('1. **既存の1件目**') && out.includes('1. **旧ブロックの1件**'));
  const parsed = parseHandoff(out);
  assert.equal(parsed.todos[0], 'Googleタスク消化: 救急セットを買う（l1/t1）');
  assert.equal(parsed.todos.length, 4);
});

test('マーカーが無いファイルは従来どおり末尾に追記する', () => {
  const out = insertTodosAtTop('# メモだけ\n', [{ listId: 'l1', taskId: 't1', title: 'あれ' }]);
  assert.ok(out.includes(MARKER) && out.includes('Googleタスク消化: あれ（l1/t1）'));
});
