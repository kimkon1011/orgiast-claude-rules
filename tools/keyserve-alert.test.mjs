import test from 'node:test';
import assert from 'node:assert/strict';
import { buildKeyserveAlert, shouldAlert } from './keyserve-alert.mjs';

const now = new Date('2026-08-20T00:00:00.000Z');

test('state が無ければ通報する', () => {
  assert.equal(shouldAlert(null, now), true);
});

test('前回通報から23時間なら通報しない', () => {
  assert.equal(shouldAlert({ lastAlert: '2026-08-19T01:00:00.000Z' }, now), false);
});

test('前回通報から25時間なら通報する', () => {
  assert.equal(shouldAlert({ lastAlert: '2026-08-18T23:00:00.000Z' }, now), true);
});

test('本文は必要情報を含み秘密名や webhook URL を含まない', () => {
  const command = 'node ~/orgiast-claude-rules/tools/onboarding-sync.mjs --force';
  const message = buildKeyserveAlert({ label: '営業PC', hostname: 'host-01', status: 401, command });
  assert.match(message, /^🚨/);
  assert.match(message, /営業PC/);
  assert.match(message, /401/);
  assert.ok(message.includes(command));
  assert.ok(!message.includes('ORGIAST_KEYSERVE_SECRET'));
  assert.ok(!message.includes('https://discord.com/api/webhooks/'));
});
