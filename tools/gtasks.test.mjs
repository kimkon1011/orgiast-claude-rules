import test from 'node:test';
import assert from 'node:assert/strict';
import { execute, makeMultipartBody, runQueued, flattenCache } from './gtasks.mjs';

test('multipart本文は日本語をUTF-8 Bufferで保持する', () => {
  const { body } = makeMultipartBody({ name: 'cmd_x.json' }, '{"title":"日本語✓"}', 'boundary');
  assert.ok(Buffer.isBuffer(body));
  assert.match(body.toString('utf8'), /日本語✓/);
});

test('キューを全部投入して結果を待つ', async () => {
  const submitted = [];
  const queue = { submit: async (id, item) => submitted.push([id, item]), takeResult: async (id) => ({ ok: true, id }) };
  const result = await runQueued([{ command: 'a', args: [] }, { command: 'b', args: ['日'] }], { queue, idFactory: (() => { let n = 0; return () => `id${++n}`; })() });
  assert.equal(submitted.length, 2);
  assert.deepEqual(result.map((item) => item.ok), [true, true]);
});

test('ok:falseを成功扱いしない', async () => {
  const queue = { submit: async () => {}, takeResult: async () => ({ ok: false, error: 'GAS failure' }) };
  await assert.rejects(runQueued([{ command: 'x', args: [] }], { queue }), /1番目: GAS failure/);
});

test('GASキュー外側がok:trueでもコマンド戻り値のok:falseを失敗にする', async () => {
  const queue = { submit: async () => {}, takeResult: async () => ({ ok: true, result: { ok: false, error: 'inner failure' } }) };
  await assert.rejects(runQueued([{ command: 'x', args: [] }], { queue }), /1番目: inner failure/);
});

test('タイムアウトは返らない番号を報告する', async () => {
  let clock = 0;
  const queue = { submit: async () => {}, takeResult: async () => null };
  await assert.rejects(runQueued([{ command: 'a', args: [] }, { command: 'b', args: [] }], {
    queue, timeoutSeconds: 1, pollMs: 1000, now: () => clock, wait: async (ms) => { clock += ms; }, idFactory: (() => { let n = 0; return () => String(++n); })(),
  }), /1番目, 2番目/);
});

test('キャッシュを通し番号付きJSON行へ変換する', () => {
  const flat = flattenCache({ updatedAt: 'now', lists: [{ id: 'l1', title: '仕事', tasks: [{ id: 't1', title: '確認', notes: '注', due: null }] }] });
  assert.deepEqual(flat.rows[0], { n: 1, listId: 'l1', list: '仕事', taskId: 't1', title: '確認', notes: '注', status: null, due: null });
});

test('getはGASでキャッシュを更新して該当タスクだけをJSONで返す', async () => {
  const submitted = [];
  const output = [];
  const queue = {
    submit: async (id, item) => submitted.push(item),
    takeResult: async () => ({ ok: true }),
    readCache: async () => ({ lists: [{ id: 'L', tasks: [
      { id: 'other', title: '別件' },
      { id: 'T', title: '確認する', notes: 'メモ', status: 'needsAction' },
    ] }] }),
  };
  const result = await execute(['get', 'L', 'T'], { queue, stdout: (text) => output.push(text) });
  assert.deepEqual(submitted, [{ command: 'dumpTasksToCache', args: [] }]);
  assert.deepEqual(result, { title: '確認する', notes: 'メモ', status: 'needsAction' });
  assert.deepEqual(JSON.parse(output[0]), result);
});

test('--userは互換用に受理し、GASキューでは無視する', async () => {
  const submitted = [];
  const queue = {
    submit: async (_id, item) => submitted.push(item),
    takeResult: async () => ({ ok: true }),
  };
  await execute(['done', 'L', 'T', '--user', 'someone@example.com'], { queue });
  assert.deepEqual(submitted, [{ command: 'completeTask', args: ['L', 'T'] }]);
});
