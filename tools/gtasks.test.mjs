import test from 'node:test';
import assert from 'node:assert/strict';
import { appendNotes, parseArgs, runCommand, tasksApi } from './gtasks.mjs';

test('notesが空なら新規テキストをそのまま設定する', () => {
  assert.equal(appendNotes('', '調査結果'), '調査結果');
  assert.equal(appendNotes(undefined, '調査結果'), '調査結果');
});

test('既存notesを消さず区切り付きで末尾へ追記する', () => {
  assert.equal(appendNotes('既存メモ', '調査結果'), '既存メモ\n\n---\n調査結果');
});

test('get/note/doneのCLI引数を解析する', () => {
  assert.deepEqual(parseArgs(['get', 'list-1', 'task-1']), {
    command: 'get', listId: 'list-1', taskId: 'task-1', user: 'kim@orgiast.jp',
  });
  assert.deepEqual(parseArgs(['note', 'list-2', 'task-2', '--text-file', 'result.txt', '--user', 'other@orgiast.jp']), {
    command: 'note', listId: 'list-2', taskId: 'task-2', user: 'other@orgiast.jp', textFile: 'result.txt',
  });
  assert.deepEqual(parseArgs(['done', 'list-3', 'task-3', '--user', 'other@orgiast.jp']), {
    command: 'done', listId: 'list-3', taskId: 'task-3', user: 'other@orgiast.jp',
  });
});

test('必須引数がなければ使い方を含むエラーにする', () => {
  assert.throws(() => parseArgs(['get', 'list-only']), /使い方/);
  assert.throws(() => parseArgs(['note', 'list', 'task']), /使い方/);
  assert.throws(() => parseArgs(['done']), /使い方/);
});

test('API失敗時はレスポンス本文を含むErrorをthrowする', async () => {
  const fetchMock = async () => ({ ok: false, status: 403, text: async () => 'scope is not authorized' });
  await assert.rejects(tasksApi('secret-token', '/lists/a/tasks/b', {}, fetchMock), (error) => {
    assert.match(error.message, /403/);
    assert.match(error.message, /scope is not authorized/);
    assert.doesNotMatch(error.message, /secret-token/);
    return true;
  });
});

test('noteは既存タスク取得後にnotesだけをPATCHする', async () => {
  const calls = [];
  const api = async (_token, path, options = {}) => {
    calls.push({ path, options });
    return options.method === 'PATCH' ? { id: 'task' } : { notes: '既存' };
  };
  await runCommand(parseArgs(['note', 'list/a', 'task b', '--text-file', 'result.txt']), {
    tokenProvider: async (options) => { assert.deepEqual(options, { scope: 'https://www.googleapis.com/auth/tasks', impersonate: 'kim@orgiast.jp' }); return 'token'; },
    api,
    readTextFile: async () => '追記',
  });
  assert.equal(calls[0].path, '/lists/list%2Fa/tasks/task%20b');
  assert.equal(calls[1].options.method, 'PATCH');
  assert.deepEqual(JSON.parse(calls[1].options.body), { notes: '既存\n\n---\n追記' });
});

test('doneはstatusだけをcompletedへPATCHする', async () => {
  let patch;
  await runCommand(parseArgs(['done', 'list', 'task']), {
    tokenProvider: async () => 'token',
    api: async (_token, _path, options) => { patch = options; return { status: 'completed' }; },
  });
  assert.deepEqual(JSON.parse(patch.body), { status: 'completed' });
});
