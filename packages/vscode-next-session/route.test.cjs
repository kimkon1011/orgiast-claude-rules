const assert = require('node:assert/strict');
const test = require('node:test');
const { decideAction } = require('./route');

test('/reload はリロードを実行する（dry指定なし）', () => {
  assert.deepEqual(decideAction({ path: '/reload', query: '' }), { kind: 'reload', dry: false });
});

test('/reload?dry=1 は dry フラグ付きでリロードを返す（実際には実行しない）', () => {
  assert.deepEqual(decideAction({ path: '/reload', query: 'dry=1' }), { kind: 'reload', dry: true });
});

test('/start は start を返す（既存動作）', () => {
  assert.deepEqual(decideAction({ path: '/start', query: 'prompt=/session-start' }), { kind: 'start' });
});

test('未知のパスは start を返す（後方互換）', () => {
  assert.deepEqual(decideAction({ path: '/foo', query: '' }), { kind: 'start' });
});

test('空のパスは start を返す', () => {
  assert.deepEqual(decideAction({ path: '', query: '' }), { kind: 'start' });
});
