import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findChat, prepareApproval, sendApproved } from './daily-beeper-approval.mjs';
import { getItem, decide } from './reply-queue.mjs';
const title = 'テスト用グループ';
const readChats = async () => ({ items: [{ id: 'test-chat', title }], hasMore: false });
const date = '2026-11-18';
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-approval-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return { home, date, title, text: '今日の承認用テスト本文', readChats, inbox: async () => ({ id: 'test-inbox' }) };
}
test('exact title across pages; missing/ambiguous/pagination failure fail closed', async () => {
  let n = 0;
  assert.equal((await findChat(title, async () => ++n === 1 ? { items: [], hasMore: true, oldestCursor: 'a' } : { items: [{ id: 'target', title }], hasMore: false })).id, 'target');
  for (const result of [{ items: [] }, { items: [{ id: 'a', title }, { id: 'b', title }] }, { items: [], hasMore: true }]) await assert.rejects(findChat(title, async () => result));
});
test('dry-run reads chats but creates no queue/inbox/receipt', async t => {
  const f = fixture(t);
  const r = await prepareApproval({ ...f, dryRun: true, inbox: () => { throw new Error('must not notify'); } });
  assert.equal(r.chatID, 'test-chat');
  assert.deepEqual(fs.readdirSync(f.home), []);
});
test('queue deduplicates and only presents, never approves or mints receipt', async t => {
  const f = fixture(t); const notices = [];
  f.inbox = async (_, options) => { notices.push(options); return { id: 'test-inbox' }; };
  const a = await prepareApproval(f), b = await prepareApproval(f);
  assert.equal(a.queueID, b.queueID);
  assert.equal(notices[0].dedupeKey, notices[1].dedupeKey);
  assert.match(notices[0].text, /1 可/);
  assert.ok(notices[0].text.includes(f.text));
  const item = getItem(f.home, a.queueID);
  assert.equal(item.state, 'presented'); assert.equal(item.receipt, undefined);
  await assert.rejects(prepareApproval({ ...f, text: '変更された本文' }), /変更/);
  await assert.rejects(sendApproved(a.queueID, { home: f.home, now: new Date('2026-11-18T01:00:00Z'), exec: () => { throw new Error('must not send'); } }), /kim承認/);
});
test('approval alone never sends stale date or edited text', async t => {
  const f = fixture(t); const a = await prepareApproval(f);
  // Isolated fixture only: models the real user decision via the public queue API.
  await decide(f.home, a.queueID, { verdict: 'approved', reason: 'unit test approval' });
  await assert.rejects(sendApproved(a.queueID, { home: f.home, now: new Date('2026-11-19T01:00:00Z') }), /当日/);
});
test('context checker failure prevents receipt and send', async t => {
  const f = fixture(t); const a = await prepareApproval(f);
  await decide(f.home, a.queueID, { verdict: 'approved', reason: 'unit test approval' });
  await assert.rejects(sendApproved(a.queueID, { home: f.home, now: new Date('2026-11-18T01:00:00Z'), exec: (_, args) => { assert.match(args[0], /send-context-check/); throw new Error('context denied'); } }), /context denied/);
  assert.equal(getItem(f.home, a.queueID).receipt, undefined);
});
