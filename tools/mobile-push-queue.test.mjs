import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enqueue, markSent, listPending, readQueue, queueFile } from './mobile-push-queue.mjs';

function testHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-push-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

test('enqueue adds a new pending push request', t => {
  const home = testHome(t);
  const id = enqueue({ owner: 'cr@orgiast.jp', title: '進捗', body: 'テスト通知', home });
  assert.ok(id);
  const items = readQueue(home);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, id);
  assert.equal(items[0].owner, 'cr@orgiast.jp');
  assert.equal(items[0].title, '進捗');
  assert.equal(items[0].body, 'テスト通知');
  assert.equal(items[0].sent, false);
});

test('listPending returns only unsent items', t => {
  const home = testHome(t);
  const id1 = enqueue({ owner: 'cr@orgiast.jp', title: 'A', body: 'a', home });
  const id2 = enqueue({ owner: 'cr@orgiast.jp', title: 'B', body: 'b', home });
  assert.equal(listPending(home).length, 2);
  markSent(id1, home);
  const pending = listPending(home);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, id2);
});

test('markSent returns false for unknown id', t => {
  const home = testHome(t);
  assert.equal(markSent('nonexistent', home), false);
});

test('markSent records sentAt and marks as sent', t => {
  const home = testHome(t);
  const id = enqueue({ owner: 'cr@orgiast.jp', title: '進捗', body: 'テスト', home });
  const before = Date.now();
  const ok = markSent(id, home);
  assert.equal(ok, true);
  const items = readQueue(home);
  assert.equal(items[0].sent, true);
  assert.ok(items[0].sentAt);
  assert.ok(Date.parse(items[0].sentAt) >= before);
});

test('queue is persistent across reads', t => {
  const home = testHome(t);
  enqueue({ owner: 'cr@orgiast.jp', title: 'T', body: 'b1', home });
  enqueue({ owner: 'cr@orgiast.jp', title: 'T', body: 'b2', home });
  const items1 = readQueue(home);
  assert.equal(items1.length, 2);
  const items2 = readQueue(home);
  assert.equal(items2.length, 2);
});

test('enqueue generates unique IDs', t => {
  const home = testHome(t);
  const ids = new Set();
  for (let i = 0; i < 10; i++) ids.add(enqueue({ owner: 'cr@orgiast.jp', title: 'T', body: `b${i}`, home }));
  assert.equal(ids.size, 10);
});
