import test from 'node:test';
import assert from 'node:assert/strict';
import { compareSite, isFetchFailure, parseSites } from './site-prelaunch-weekly.mjs';

const check = (id, verdict, item = `項目${id}`, evidence = `根拠${id}`) => ({ id, verdict, item, evidence });
const site = (type, checks, extra = {}) => ({ url: 'https://example.com/', type, checks, fetchFailed: false, ...extra });

test('設定をURLと種別へ変換する', () => {
  assert.deepEqual(parseSites('# comment\nhttps://example.com\tpublic\n'), [{ url: 'https://example.com/', type: 'public' }]);
  assert.throws(() => parseSites('https://example.com\tunknown'), /種別が不正/);
});

test('NG件数の増加とOK→NGを検出する', () => {
  const previous = site('public', [check(1, 'OK'), check(2, 'NG')]);
  const current = site('public', [check(1, 'NG'), check(2, 'NG')]);
  const change = compareSite(previous, current);
  assert.equal(change.ngBefore, 1);
  assert.equal(change.ngAfter, 2);
  assert.deepEqual(change.items.map(item => item.id), [1]);
  assert.deepEqual(change.okToNg.map(item => item.id), [1]);
});

test('NG件数が同じでもOK→NGを検出する', () => {
  const previous = site('public', [check(1, 'OK'), check(2, 'NG')]);
  const current = site('public', [check(1, 'NG'), check(2, 'OK')]);
  assert.deepEqual(compareSite(previous, current).items.map(item => item.id), [1]);
});

test('取得失敗をサイト停止として検出する', () => {
  const checks = [check(1, '要手動', '項目1', 'ネットワーク失敗: fetch failed'), check(2, '要手動', '項目2', 'ネットワーク失敗: fetch failed')];
  assert.equal(isFetchFailure(checks), true);
  assert.equal(compareSite(site('public', [check(1, 'OK')]), site('public', checks, { fetchFailed: true })).kind, 'stopped');
});

test('変化なしは通知対象にしない', () => {
  const previous = site('public', [check(1, 'NG'), check(2, 'OK')]);
  const current = site('public', [check(1, 'NG'), check(2, 'OK')]);
  assert.equal(compareSite(previous, current), null);
});

test('internalは5・6・7・9、apiは3・4・24以外を比較しない', () => {
  const internalBefore = site('internal', [check(5, 'OK'), check(8, 'OK')]);
  const internalAfter = site('internal', [check(5, 'NG'), check(8, 'OK')]);
  assert.equal(compareSite(internalBefore, internalAfter), null);
  const apiBefore = site('api', [check(1, 'OK'), check(3, 'OK'), check(24, 'OK')]);
  const apiExcluded = site('api', [check(1, 'NG'), check(3, 'OK'), check(24, 'OK')]);
  assert.equal(compareSite(apiBefore, apiExcluded), null);
  const apiIncluded = site('api', [check(1, 'OK'), check(3, 'NG'), check(24, 'OK')]);
  assert.deepEqual(compareSite(apiBefore, apiIncluded).items.map(item => item.id), [3]);
});
