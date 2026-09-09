import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOWTO, MARKER, appendTodoBlock, insertTodosAtTop, isSkipped, parseClassifications, plan, readSkip, readState, selectTasks, titleKey } from './gtasks-loop.mjs';
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
  await plan({ dryRun: true, classify: false, stateFile, nextFile, fetchCache: async () => cache });
  assert.equal(fs.readFileSync(nextFile, 'utf8'), before);
  assert.equal(fs.existsSync(stateFile), false);
  await plan({ classify: false, stateFile, nextFile, fetchCache: async () => cache, now: () => new Date('2026-09-03T00:00:00Z') });
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

test('HOWTOは夜間の外部送信を禁止し下書き保存を指示する', () => {
  assert.match(HOWTO, /禁止.*Discord DM・メール・チャットワーク.*外部へ送信しない/);
  assert.match(HOWTO, /gtasks-drafts\/<taskId>\.md/);
  assert.match(HOWTO, /送信は kim が明示的に指示したときだけ/);
  assert.match(HOWTO, /■ 要確認:/);
  assert.match(HOWTO, /■ kimの残り1操作:/);
});

test('HOWTOは回答待ちタスクへの同一質問の再追記を禁止する', () => {
  assert.match(HOWTO, /get <listId> <taskId>` で既存メモ/);
  assert.match(HOWTO, /同じ趣旨の質問が既にあれば二度と追記しない/);
  assert.match(HOWTO, /新しく聞くことが無い限り note せず/);
});

function planFixture(t, titles, extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtasks-classify-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return {
    stateFile: path.join(dir, 'state.json'),
    nextFile: path.join(dir, 'next.md'),
    skipFile: path.join(dir, 'skip.json'),
    classifyCacheFile: path.join(dir, 'classify-cache.json'),
    fetchCache: async () => ({ lists: [{ id: 'L', title: '仕事', tasks: titles.map((title, index) => ({ id: `T${index + 1}`, title })) }] }),
    ...extra,
  };
}

test('memo判定を外して後続のtaskを3件に繰り上げる', async (t) => {
  const fixture = planFixture(t, ['格言です', '作業A', '作業B', '作業C']);
  const result = await plan({ ...fixture, classifyRows: async () => '{"n":1,"c":"memo"}\n{"n":2,"c":"task"}\n{"n":3,"c":"task"}\n{"n":4,"c":"task"}' });
  assert.deepEqual(result.memos.map((row) => row.taskId), ['T1']);
  assert.deepEqual(result.picked.map((row) => row.taskId), ['T2', 'T3', 'T4']);
  assert.equal(JSON.parse(fs.readFileSync(fixture.stateFile)).picked.T1.status, 'skipped-memo');
});

test('分類の例外・タイムアウトはfail-openで従来どおり上から3件を選ぶ', async (t) => {
  for (const message of ['network failure', 'timed out']) {
    const fixture = planFixture(t, [`${message}-1`, `${message}-2`, `${message}-3`, `${message}-4`]);
    const result = await plan({ ...fixture, dryRun: true, classifyRows: async () => { throw new Error(message); } });
    assert.deepEqual(result.picked.map((row) => row.taskId), ['T1', 'T2', 'T3']);
    assert.deepEqual(result.memos, []);
  }
});

test('空・壊れたJSONなど判定不能な出力はtask扱い', () => {
  assert.deepEqual([...parseClassifications('', 2)], []);
  assert.deepEqual([...parseClassifications('broken\n{"n":9,"c":"memo"}\n{"n":1,"c":"unknown"}', 2)], []);
});

test('memoのタイトル先頭24字をskipへ重複なしで追記し既存キーを保つ', async (t) => {
  const longTitle = 'これは二十四文字より長い内省メモなので先頭だけ保存される文章';
  const fixture = planFixture(t, [longTitle]);
  fs.writeFileSync(fixture.skipFile, JSON.stringify({ _comment: 'keep', listIds: ['existing'], titles: [] }));
  await plan({ ...fixture, classifyRows: async () => '{"n":1,"c":"memo"}' });
  fixture.fetchCache = async () => ({ lists: [{ id: 'L', tasks: [{ id: 'T2', title: longTitle }] }] });
  await plan({ ...fixture, classifyRows: async () => { throw new Error('skip should avoid this'); } });
  const saved = JSON.parse(fs.readFileSync(fixture.skipFile));
  assert.deepEqual(saved, { _comment: 'keep', listIds: ['existing'], titles: [titleKey(longTitle)] });
});

test('キャッシュ済み文言では分類関数を呼ばない', async (t) => {
  const fixture = planFixture(t, ['既知の実作業']);
  fs.writeFileSync(fixture.classifyCacheFile, JSON.stringify({ [titleKey('既知の実作業')]: 'task' }));
  let calls = 0;
  const result = await plan({ ...fixture, dryRun: true, classifyRows: async () => { calls++; return ''; } });
  assert.equal(calls, 0);
  assert.deepEqual(result.picked.map((row) => row.taskId), ['T1']);
});

test('dry-runは分類結果を返すがstate・skip・cache・nextを書かない', async (t) => {
  const fixture = planFixture(t, ['内省メモ', '実作業']);
  const result = await plan({ ...fixture, dryRun: true, classifyRows: async () => '{"n":1,"c":"memo"}\n{"n":2,"c":"task"}' });
  assert.deepEqual(result.memos.map((row) => row.taskId), ['T1']);
  for (const file of [fixture.stateFile, fixture.skipFile, fixture.classifyCacheFile, fixture.nextFile]) assert.equal(fs.existsSync(file), false, file);
});
