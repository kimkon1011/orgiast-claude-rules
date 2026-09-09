const assert = require('node:assert/strict');
const test = require('node:test');
const { decideAction, shouldRetryMobileTab } = require('./route');

test('/reload はリロードを実行する（dry指定なし）', () => {
  assert.deepEqual(decideAction({ path: '/reload', query: '' }), { kind: 'reload', dry: false });
});

test('/reload?dry=1 は dry フラグ付きでリロードを返す（実際には実行しない）', () => {
  assert.deepEqual(decideAction({ path: '/reload', query: 'dry=1' }), { kind: 'reload', dry: true });
});

test('/start は start を返す（既存動作）', () => {
  assert.deepEqual(decideAction({ path: '/start', query: 'prompt=/session-start' }), { kind: 'start' });
});

test('/mobile は count と name を返し、count を 1..10 に収める', () => {
  assert.deepEqual(decideAction({ path: '/mobile', query: 'count=4&name=%E6%90%BA%E5%B8%AF%E7%94%A8' }), { kind: 'mobile', count: 4, name: '携帯用' });
  assert.deepEqual(decideAction({ path: '/mobile', query: 'count=99' }), { kind: 'mobile', count: 10, name: 'スマホ用セッション' });
  assert.deepEqual(decideAction({ path: '/mobile', query: 'count=0&name=' }), { kind: 'mobile', count: 1, name: 'スマホ用セッション' });
  assert.deepEqual(decideAction({ path: '/mobile', query: 'count=invalid' }), { kind: 'mobile', count: 3, name: 'スマホ用セッション' });
});

test('未知のパスは start を返す（後方互換）', () => {
  assert.deepEqual(decideAction({ path: '/foo', query: '' }), { kind: 'start' });
});

test('空のパスは start を返す', () => {
  assert.deepEqual(decideAction({ path: '', query: '' }), { kind: 'start' });
});

test('スマホ用タブは失敗回数が上限未満の間だけ再試行する', () => {
  assert.equal(shouldRetryMobileTab(1, 12), true);
  assert.equal(shouldRetryMobileTab(12, 12), false);
});
