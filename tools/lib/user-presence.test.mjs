import test from 'node:test';
import assert from 'node:assert/strict';
import { getIdleSeconds, canTouchScreen } from './user-presence.mjs';

test('getIdleSeconds: エラー時は 0（安全側）を返す', () => {
  const spawn = () => ({ error: new Error('fail'), status: 1 });
  assert.equal(getIdleSeconds({ spawn }), 0);
});

test('getIdleSeconds: 例外時も 0', () => {
  const spawn = () => { throw new Error('crash'); };
  assert.equal(getIdleSeconds({ spawn }), 0);
});

test('getIdleSeconds: stdout から数値をパースする', () => {
  const spawn = () => ({ status: 0, stdout: '12345' });
  assert.equal(getIdleSeconds({ spawn }), 12345);
});

test('getIdleSeconds: 空白トリム', () => {
  const spawn = () => ({ status: 0, stdout: '  3600  ' });
  assert.equal(getIdleSeconds({ spawn }), 3600);
});

test('getIdleSeconds: 異常な出力は 0', () => {
  const spawn = () => ({ status: 0, stdout: 'abc' });
  assert.equal(getIdleSeconds({ spawn }), 0);
});

test('getIdleSeconds: 負の値は 0', () => {
  const spawn = () => ({ status: 0, stdout: '-1' });
  assert.equal(getIdleSeconds({ spawn }), 0);
});

test('canTouchScreen: 十分にアイドルなら ok=true', () => {
  const getIdleSec = () => 3600;
  const result = canTouchScreen({ minIdleSec: 900, getIdleSec });
  assert.equal(result.ok, true);
  assert.equal(result.idleSec, 3600);
  assert.ok(result.reason.includes('3600'));
});

test('canTouchScreen: アイドル不足なら ok=false', () => {
  const getIdleSec = () => 30;
  const result = canTouchScreen({ minIdleSec: 900, getIdleSec });
  assert.equal(result.ok, false);
  assert.equal(result.idleSec, 30);
  assert.ok(result.reason.includes('30'));
});

test('canTouchScreen: 既定の minIdleSec は 900', () => {
  const getIdleSec = () => 900;
  const result = canTouchScreen({ getIdleSec });
  assert.equal(result.ok, true);
});

test('canTouchScreen: 閾値ちょうどは ok=true', () => {
  const getIdleSec = () => 600;
  const result = canTouchScreen({ minIdleSec: 600, getIdleSec });
  assert.equal(result.ok, true);
});