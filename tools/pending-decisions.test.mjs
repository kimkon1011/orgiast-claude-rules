import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addDecision, listDecisions, markDecisions, queuePath } from './pending-decisions.mjs';

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'pending-decisions-')); }
test('add, list, and mark decisions', () => {
  const dir = home();
  const item = addDecision({ source: 'discord-inbox', text: '確認する', author: 'kim' }, { home: dir, now: new Date('2026-08-31T01:02:03Z') });
  assert.equal(listDecisions({ home: dir, status: 'pending' }).length, 1);
  markDecisions([item.id], { home: dir, status: 'batched', batchDate: '2026-08-31' });
  assert.deepEqual(listDecisions({ home: dir })[0], { ...item, status: 'batched', batchDate: '2026-08-31' });
});
test('ignores broken lines and rejects empty text', () => {
  const dir = home();
  fs.mkdirSync(path.dirname(queuePath({ home: dir })), { recursive: true });
  fs.writeFileSync(queuePath({ home: dir }), '{broken}\n');
  assert.deepEqual(listDecisions({ home: dir }), []);
  assert.throws(() => addDecision({ text: '   ' }, { home: dir }), /テキスト/);
});
