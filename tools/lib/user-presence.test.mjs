import test from 'node:test';
import assert from 'node:assert/strict';
import { getIdleSeconds, canTouchScreen } from './user-presence.mjs';

test('getIdleSeconds: spawn returns {status:0, stdout:"1234\\n"} → idleSec=1234', () => {
  const spawn = () => ({ status: 0, stdout: '1234\n' });
  const result = getIdleSeconds({ spawn });
  assert.equal(result.ok, true);
  assert.equal(result.idleSec, 1234);
  assert.equal(result.reason, 'ok');
});

test('getIdleSeconds: spawn returns {status:1} → ok:false', () => {
  const spawn = () => ({ status: 1, stdout: '' });
  const result = getIdleSeconds({ spawn });
  assert.equal(result.ok, false);
  assert.equal(result.idleSec, 0);
  assert.ok(result.reason.includes('exit code'));
});

test('getIdleSeconds: spawn returns {error} → ok:false', () => {
  const spawn = () => ({ status: null, stdout: '', error: new Error('timeout') });
  const result = getIdleSeconds({ spawn });
  assert.equal(result.ok, false);
  assert.equal(result.idleSec, 0);
  assert.ok(result.reason.includes('timeout'));
});

test('getIdleSeconds: spawn throws → ok:false', () => {
  const spawn = () => { throw new Error('spawn failed'); };
  const result = getIdleSeconds({ spawn });
  assert.equal(result.ok, false);
  assert.equal(result.idleSec, 0);
  assert.ok(result.reason.includes('spawn failed'));
});

test('canTouchScreen: idleSec >= threshold → ok:true', () => {
  const getIdleImpl = () => ({ ok: true, idleSec: 1200, reason: 'ok' });
  const result = canTouchScreen(600, { getIdleImpl });
  assert.equal(result.ok, true);
  assert.equal(result.idleSec, 1200);
  assert.equal(result.reason, 'ok');
});

test('canTouchScreen: idleSec < threshold → ok:false', () => {
  const getIdleImpl = () => ({ ok: true, idleSec: 300, reason: 'ok' });
  const result = canTouchScreen(600, { getIdleImpl });
  assert.equal(result.ok, false);
  assert.equal(result.idleSec, 300);
  assert.ok(result.reason.includes('user-active'));
});

test('canTouchScreen: getIdleImpl returns ok:false → ok:false', () => {
  const getIdleImpl = () => ({ ok: false, idleSec: 0, reason: 'error' });
  const result = canTouchScreen(600, { getIdleImpl });
  assert.equal(result.ok, false);
  assert.equal(result.idleSec, 0);
  assert.equal(result.reason, 'error');
});
