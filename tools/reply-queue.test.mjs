import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  enqueueItems,
  listItems,
  getItem,
  saveDraft,
  present,
  decide,
  issueReceipt,
  markSent,
  reconcile,
  status
} from './reply-queue.mjs';

function createTempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rq-test-'));
}

test('1. 同じ 2 件の items を 2 回 enqueue', async t => {
  const home = createTempHome();
  const items = [
    { channel: 'discord', thread: 'ch1', message: 'm1', from: { id: 'u2', name: '相手' }, body: '質問1' },
    { channel: 'discord', thread: 'ch1', message: 'm2', from: { id: 'u2', name: '相手' }, body: '質問2' }
  ];

  const res1 = enqueueItems(home, items);
  assert.strictEqual(res1.added.length, 2);
  assert.strictEqual(res1.duplicates.length, 0);

  const res2 = enqueueItems(home, items);
  assert.strictEqual(res2.added.length, 0);
  assert.strictEqual(res2.duplicates.length, 2);

  const list = listItems(home);
  assert.strictEqual(list.length, 2);
});

test('2. 必須項目欠落（body 無し）で throw', async t => {
  const home = createTempHome();
  const invalidItems = [
    { channel: 'discord', thread: 'ch1', message: 'm1', from: { id: 'u2', name: '相手' } }
  ];

  assert.throws(() => {
    enqueueItems(home, invalidItems);
  });
});

test('3. 正常系: enqueue -> saveDraft -> present -> decide approved -> issueReceipt -> markSent', async t => {
  const home = createTempHome();
  const item = { channel: 'discord', thread: 'ch1', message: 'm1', from: { id: 'u2', name: '相手' }, body: '質問です' };
  const res = enqueueItems(home, [item]);
  const id = res.ids[0];

  const draftItem = saveDraft(home, id, { text: '下書き' });
  assert.strictEqual(draftItem.state, 'drafted');

  const presItem = present(home, id);
  assert.strictEqual(presItem.state, 'presented');

  const decItem = await decide(home, id, { verdict: 'approved' });
  assert.strictEqual(decItem.state, 'approved');

  const receiptRes = issueReceipt(home, id, { fetchLatest: () => [] });
  assert.strictEqual(receiptRes.ok, true);
  assert.ok(receiptRes.receipt);

  const sentItem = markSent(home, id, { receiptId: receiptRes.receipt.id, messageId: 'msg-100' });
  assert.strictEqual(sentItem.state, 'sent');
  assert.strictEqual(sentItem.sent.messageId, 'msg-100');
});

test('4. 文脈変化: decide approved 後、新着メッセージありで queued に戻る', async t => {
  const home = createTempHome();
  const item = { channel: 'discord', thread: 'ch1', message: 'm1', from: { id: 'u2', name: '相手' }, body: '質問です' };
  const res = enqueueItems(home, [item]);
  const id = res.ids[0];

  saveDraft(home, id, { text: '下書き' });
  present(home, id);
  await decide(home, id, { verdict: 'approved' });

  const fetchLatest = () => [{ id: '999', authorId: 'u2', authorName: '相手', ts: '2026-11-07T00:00:00Z', content: '追記です' }];
  const receiptRes = issueReceipt(home, id, { fetchLatest });
  assert.strictEqual(receiptRes.ok, false);
  assert.strictEqual(receiptRes.reason, 'context_changed');

  const updated = getItem(home, id);
  assert.strictEqual(updated.state, 'queued');
  assert.strictEqual(updated.receipt, undefined);
});

test('5. kim 自身の新着と bot の新着だけなら receipt が出る', async t => {
  const home = createTempHome();
  const item = { channel: 'discord', thread: 'ch1', message: 'm1', from: { id: 'u2', name: '相手' }, body: '質問です' };
  const res = enqueueItems(home, [item]);
  const id = res.ids[0];

  saveDraft(home, id, { text: '下書き' });
  present(home, id);
  await decide(home, id, { verdict: 'approved' });

  const fetchLatest = () => [
    { id: '1000', authorId: '715210673642012733', authorName: 'Kim', ts: '2026-11-07T00:01:00Z', content: '自分の追記' },
    { id: '1001', authorId: 'bot1', authorName: 'Bot', ts: '2026-11-07T00:02:00Z', content: 'ボット応答', bot: true }
  ];
  const receiptRes = issueReceipt(home, id, { fetchLatest, kimId: '715210673642012733' });
  assert.strictEqual(receiptRes.ok, true);
  assert.ok(receiptRes.receipt);
});

test('6. 二重送信防止: sent 済みに issueReceipt -> already_sent', async t => {
  const home = createTempHome();
  const item = { channel: 'discord', thread: 'ch1', message: 'm1', from: { id: 'u2', name: '相手' }, body: '質問です' };
  const res = enqueueItems(home, [item]);
  const id = res.ids[0];

  saveDraft(home, id, { text: '下書き' });
  present(home, id);
  await decide(home, id, { verdict: 'approved' });

  const receiptRes1 = issueReceipt(home, id, { fetchLatest: () => [] });
  markSent(home, id, { receiptId: receiptRes1.receipt.id, messageId: 'msg-1' });

  const receiptRes2 = issueReceipt(home, id, { fetchLatest: () => [] });
  assert.strictEqual(receiptRes2.ok, false);
  assert.strictEqual(receiptRes2.reason, 'already_sent');
});

test('7. 失効: markSent 時の期限切れチェック', async t => {
  const home = createTempHome();
  const item = { channel: 'discord', thread: 'ch1', message: 'm1', from: { id: 'u2', name: '相手' }, body: '質問です' };
  const res = enqueueItems(home, [item]);
  const id = res.ids[0];

  saveDraft(home, id, { text: '下書き' });
  present(home, id);
  await decide(home, id, { verdict: 'approved' });

  const nowT = Date.now();
  const receiptRes = issueReceipt(home, id, { fetchLatest: () => [], now: new Date(nowT) });
  const receiptId = receiptRes.receipt.id;

  assert.throws(() => {
    markSent(home, id, { receiptId, messageId: 'msg-1', now: new Date(nowT + 61000) });
  }, (err) => {
    return err.exitCode === 5 || /期限/.test(err.message);
  });

  const sentItem = markSent(home, id, { receiptId, messageId: 'msg-1', now: new Date(nowT + 30000) });
  assert.strictEqual(sentItem.state, 'sent');
});

test('8. decide edited で corrections.jsonl 追加、diffRatio > 0、verdict edited', async t => {
  const home = createTempHome();
  const item1 = { channel: 'discord', thread: 'ch1', message: 'm1', from: { id: 'u2', name: '相手' }, body: '質問1' };
  const res1 = enqueueItems(home, [item1]);
  const id1 = res1.ids[0];

  saveDraft(home, id1, { text: '元の件' });
  present(home, id1);
  await decide(home, id1, { verdict: 'edited', finalText: '修正後の件' });

  const correctionsPath = path.join(home, '.claude', 'reply-learning', 'corrections.jsonl');
  assert.ok(fs.existsSync(correctionsPath));

  let lines = fs.readFileSync(correctionsPath, 'utf-8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 1);

  const entry1 = JSON.parse(lines[0]);
  assert.strictEqual(entry1.itemId, id1);
  assert.strictEqual(entry1.verdict, 'edited');
  assert.strictEqual(entry1.final, '修正後の件');
  assert.ok(entry1.diffRatio > 0);

  const item2 = { channel: 'discord', thread: 'ch1', message: 'm2', from: { id: 'u2', name: '相手' }, body: '質問2' };
  const res2 = enqueueItems(home, [item2]);
  const id2 = res2.ids[0];

  saveDraft(home, id2, { text: 'そのままでOK' });
  present(home, id2);
  await decide(home, id2, { verdict: 'approved' });

  lines = fs.readFileSync(correctionsPath, 'utf-8').trim().split('\n').filter(Boolean);
  assert.strictEqual(lines.length, 2);

  const entry2 = JSON.parse(lines[1]);
  assert.strictEqual(entry2.itemId, id2);
  assert.strictEqual(entry2.verdict, 'approved');
  assert.strictEqual(entry2.diffRatio, 0);
});

test('9. 不正遷移: queued に markSent / drafted に reconcile で throw', async t => {
  const home = createTempHome();
  const item = { channel: 'discord', thread: 'ch1', message: 'm1', from: { id: 'u2', name: '相手' }, body: '質問です' };
  const res = enqueueItems(home, [item]);
  const id = res.ids[0];

  assert.throws(() => {
    markSent(home, id, { receiptId: 'rc-dummy', messageId: 'msg-1' });
  });

  saveDraft(home, id, { text: '下書き' });
  assert.throws(() => {
    reconcile(home, id, { messageId: 'msg-1' });
  });
});

test('10. status: enqueue 2 件（discord と email）でのカウントと unreadable', async t => {
  const home = createTempHome();
  const items = [
    { channel: 'discord', thread: 'ch1', message: 'm1', from: { id: 'u2', name: '相手' }, body: '質問1' },
    { channel: 'email', thread: 'th2', message: 'm2', from: { name: '相手2' }, body: '質問2' }
  ];
  enqueueItems(home, items);

  const st = status(home);
  assert.strictEqual(st.byState.queued, 2);
  assert.strictEqual(st.stateByChannel.queued.discord, 1);
  assert.ok(Array.isArray(st.unreadable));
  assert.ok(st.unreadable.some(s => s.includes('kim 個人 DM')));
});

test('11. ロック競合: queue.lock がある状態で lockWaitMs 200 で throw', async t => {
  const home = createTempHome();
  const lockDir = path.join(home, '.claude', 'reply-queue');
  fs.mkdirSync(lockDir, { recursive: true });
  const lockFile = path.join(lockDir, 'queue.lock');
  fs.writeFileSync(lockFile, 'locked');

  const item = { channel: 'discord', thread: 'ch1', message: 'm1', from: { id: 'u2', name: '相手' }, body: '質問です' };
  const start = Date.now();

  assert.throws(() => {
    enqueueItems(home, [item], { lockWaitMs: 200 });
  }, /使用中/);

  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 150, `elapsed expected >= 150ms, got ${elapsed}ms`);
});

