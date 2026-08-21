import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './cron-liveness-check.mjs';

const now = Date.parse('2026-08-21T00:00:00.000Z');
const entry = { label: '日次', repo: 'owner/repo', workflow: 'daily.yml', everyDays: 1 };
const key = 'owner/repo#daily.yml';

function result(value) {
  return evaluate([entry], { [key]: value }, now)[0];
}

test('直近のschedule成功はok', () => {
  const actual = result('2026-08-20T00:00:00.000Z');
  assert.equal(actual.status, 'ok');
  assert.match(actual.line, /^✅/);
});

test('許容期間を超えたschedule成功はstale', () => {
  const actual = result('2026-08-19T00:00:00.000Z');
  assert.equal(actual.status, 'stale');
  assert.match(actual.line, /^🚨/);
});

test('schedule成功履歴なしはnever', () => {
  const actual = result(null);
  assert.equal(actual.status, 'never');
  assert.equal(actual.lastSuccess, null);
});

test('取得失敗はunknown', () => {
  const actual = evaluate([entry], {}, now)[0];
  assert.equal(actual.status, 'unknown');
  assert.match(actual.line, /^⚠️/);
});

test('境界値はok、境界を超えるとstale', () => {
  assert.equal(result('2026-08-19T12:00:00.000Z').status, 'ok');
  assert.equal(result('2026-08-19T11:59:59.999Z').status, 'stale');
});
