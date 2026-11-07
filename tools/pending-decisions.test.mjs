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

test('ORGIAST_HOME selects decision storage while explicit home takes precedence', t => {
  const dir = home();
  const explicit = home();
  const previous = process.env.ORGIAST_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.ORGIAST_HOME;
    else process.env.ORGIAST_HOME = previous;
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(explicit, { recursive: true, force: true });
  });
  process.env.ORGIAST_HOME = dir;
  assert.equal(queuePath(), path.join(dir, '.claude', 'pending-decisions.jsonl'));
  const record = addDecision({ text: '環境変数の保存先' });
  markDecisions([record.id], { status: 'batched' });
  assert.equal(listDecisions()[0].status, 'batched');
  addDecision({ text: '明示した保存先' }, { home: explicit });
  assert.equal(listDecisions({ home: explicit })[0].text, '明示した保存先');
  assert.equal(listDecisions().length, 1);
});


test('pending and legacy open share a filter without rewriting stored status', t => {
  const dir = home();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const records = ['pending', 'open', 'batched', 'resolved', 'closed', 'done', 'cancelled', 'invalid', '', null].map((status, i) => ({ id: String(i), status, text: 'decision' }));
  records.push({ id: 'missing', text: 'no status' });
  fs.mkdirSync(path.dirname(queuePath({ home: dir })), { recursive: true });
  const original = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(queuePath({ home: dir }), original);
  for (const status of ['pending', 'open']) {
    assert.deepEqual(listDecisions({ home: dir, status }).map(r => r.id), ['0', '1']);
  }
  assert.equal(listDecisions({ home: dir, status: 'resolved' })[0].id, '3');
  assert.deepEqual(listDecisions({ home: dir }), records);
  assert.equal(fs.readFileSync(queuePath({ home: dir }), 'utf8'), original);
});
