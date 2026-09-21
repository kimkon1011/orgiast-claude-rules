import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeExecutorStatus, executorExitStatus } from './executor-status.mjs';

test('legacy exit codes normalize without hiding explicit failures', () => {
  for (const status of [undefined, null, 0, '0', 'ok']) assert.equal(normalizeExecutorStatus({ status }), 'ok');
  for (const status of [1, '1', 9, '9']) assert.equal(normalizeExecutorStatus({ status }), 'error');
  for (const status of [124, '124']) assert.equal(normalizeExecutorStatus({ status }), 'timeout');
  assert.equal(normalizeExecutorStatus({ timedOut: true }), 'timeout');
  assert.equal(normalizeExecutorStatus({ ok: false }), 'error');
  assert.equal(normalizeExecutorStatus({ launched: false }), 'error');
  assert.equal(normalizeExecutorStatus({ status: 'http_429' }), 'http_429');
  assert.equal(normalizeExecutorStatus({ status: 'no-cheap-executor' }), 'unrouted');
});

test('new process records require confirmed zero exit and preserve timeout', () => {
  for (const status of [0, '0']) assert.equal(executorExitStatus({ status }), 'ok');
  for (const status of [null, undefined, 1, '1']) assert.equal(executorExitStatus({ status }), 'error');
  assert.equal(executorExitStatus({ status: 124 }), 'timeout');
  assert.equal(executorExitStatus({ status: null, timedOut: true }), 'timeout');
  assert.equal(executorExitStatus({ status: 0, error: new Error('spawn') }), 'error');
});
