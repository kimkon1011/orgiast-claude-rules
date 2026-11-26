import test from 'node:test';
import assert from 'node:assert/strict';
import { escalationText } from './auto-progress-escalate.mjs';
import { parseEscalation, priorEscalations, syncEscalationAnswer } from './lib/escalation-answer-sync.mjs';

const row = { ts: '2026-11-04T10:00:00.000Z', sessionId: 'abcdef12-3456', status: 'waiting_user',
  nextKim: 'A/B/C で回答', ask: 'A案を承認しますか', nextClaude: '承認後に作業する' };
const now = Date.parse('2026-11-10T10:00:00Z');
const item = { id: 'ki-test', kind: 'ask', status: 'dropped', text: escalationText(row, now) };

test('補足付きの本文から元の台帳行を特定できる', () => {
  assert.deepEqual(parseEscalation(item), { ts: row.ts, session: 'abcdef12' });
});

test('自動取り下げは書き戻しと再質問抑止の対象外、手動取り下げは対象', () => {
  const auto = { ...item, autoExpired: true };
  const current = { ...row };
  const writes = [];
  const io = { readLedger: () => [current], writeLedger: (file, rows) => writes.push(rows) };

  assert.deepEqual(priorEscalations([auto, item], row).closed, [item]);
  assert.equal(syncEscalationAnswer('/unused', auto, { now, io }), false);
  assert.equal(current.status, 'waiting_user');
  assert.equal(writes.length, 0);
  assert.equal(syncEscalationAnswer('/unused', item, { now, io }), true);
  assert.equal(current.status, 'done');
  assert.equal(writes.length, 1);
});
