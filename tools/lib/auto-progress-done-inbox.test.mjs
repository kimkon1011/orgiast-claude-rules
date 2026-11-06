// kim 席の完了通知は kim-inbox に積むだけでなく、許可リストに合う本文は Discord DM にも流す
// （kim 2026-11-04／11-06「聞かなくても進捗を届けて」。11/05 の完了通知 25 件が全部 session-inbox 止まりだった実測から）。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { deliverDoneInbox } from './auto-progress-done-inbox.mjs';

function fakeInbox() {
  const items = [];
  return {
    items,
    addKimInboxItem: async (_home, item) => { const saved = { id: `ki-${items.length + 1}`, ...item }; items.push(saved); return saved; },
    listKimInboxItems: () => items,
  };
}

test('完了通知（✅ 自動進行が完了しました）は inbox に積んだうえで Discord にも送る', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'done-inbox-'));
  const inbox = fakeInbox();
  const sent = [];
  const io = { ...inbox, notifyKim: async (text, opts) => { sent.push({ text, opts }); return { delivered: 'dm', messageId: 'm1' }; } };
  const delivery = await deliverDoneInbox(home, [{ sessionId: 's1', ts: '2026-11-06T00:00:00Z' }], '【作業用011】\n✅ 自動進行が完了しました\n✅ 完了: PR #1500', { io });
  assert.equal(delivery.delivered, 'session-inbox');
  assert.equal(inbox.items.length, 1);
  assert.equal(sent.length, 1);
  assert.equal(delivery.discord?.delivered, 'dm');
});

test('許可リストに合わない本文は Discord に送らない（inbox だけ）', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'done-inbox-'));
  const inbox = fakeInbox();
  const sent = [];
  const io = { ...inbox, notifyKim: async (text) => { sent.push(text); return { delivered: 'dm' }; } };
  const delivery = await deliverDoneInbox(home, [{ sessionId: 's2', ts: '2026-11-06T00:00:00Z' }], 'PR #123 をマージしてください', { io });
  assert.equal(delivery.delivered, 'session-inbox');
  assert.equal(sent.length, 0);
  assert.equal(delivery.discord, undefined);
});

test('Discord 送信が失敗しても inbox の受領は成立する', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'done-inbox-'));
  const inbox = fakeInbox();
  const io = { ...inbox, notifyKim: async () => { throw new Error('discord down'); } };
  const delivery = await deliverDoneInbox(home, [{ sessionId: 's3', ts: '2026-11-06T00:00:00Z' }], '✅ 自動進行が完了しました\n完了: x', { io });
  assert.equal(delivery.delivered, 'session-inbox');
  assert.match(String(delivery.discord?.reason || ''), /discord down/);
});
