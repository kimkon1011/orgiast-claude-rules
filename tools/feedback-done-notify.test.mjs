import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDonePayload, formatUndeliverable, pickRecipient, selectPending } from './feedback-done-notify.mjs';

const member = { id: '42', username: 'taro', global_name: '山田太郎', nick: null };
test('pickRecipient は台帳の Discord ID を優先する', () => assert.deepEqual(pickRecipient({ submitter_discord_id: '99', submitter: '山田太郎' }, [member]), { id: '99', label: '99' }));
test('pickRecipient は名前を解決し、解決不能なら null', () => {
  assert.deepEqual(pickRecipient({ submitter: '山田太郎' }, [member]), { id: '42', label: '山田太郎' });
  assert.equal(pickRecipient({ submitter: '不明' }, [member]), null);
});
test('buildDonePayload は既定 summary と Issue URL を入れる', () => assert.deepEqual(buildDonePayload({ number: 7, app_name: '購買', title: '保存不可', submitter_discord_id: '42' }, { url: 'https://github.test/issues/7' }), {
  submitter_discord_id: '42', app_name: '購買', title: '保存不可', summary: '対応が完了しました（GitHub Issue #7 クローズ）', url: 'https://github.test/issues/7', notify_kim: true,
}));
test('selectPending は通知済みと未クローズを除き limit を守る', () => {
  const ledger = [{ message_id: 'a' }, { message_id: 'b' }, { message_id: 'c' }, { message_id: 'd' }];
  const issues = { a: { state: 'CLOSED' }, b: { state: 'CLOSED' }, c: { state: 'OPEN' }, d: { state: 'CLOSED' } };
  assert.deepEqual(selectPending(ledger, [{ message_id: 'a' }], issues, 1).map((x) => x.ledgerItem.message_id), ['b']);
});
test('formatUndeliverable は0件なら空文字、項目があれば指定形式にする', () => {
  assert.equal(formatUndeliverable([]), '');
  assert.equal(formatUndeliverable([{ ledgerItem: { app_name: '購買', title: '保存不可', submitter: '佐藤' }, issue: { url: 'https://github.test/issues/1' } }]), '・[購買] 保存不可 … 提出者「佐藤」を Discord で特定できず未返信 / https://github.test/issues/1');
});

test('本人のみの通知はkimへの控えを無効化する', () => {
  assert.equal(buildDonePayload({ title: '修正' }, {}, { notify_kim: false }).notify_kim, false);
});

test('recipient-onlyはdryで送信せず本送信と重複抑止・未達時もkimへ送らない', async (t) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { main } = await import('./feedback-done-notify.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'done-notify-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'relay.env'), 'FEEDBACK_RELAY_URL=https://relay.test/api/feedback-intake\nFEEDBACK_RELAY_SECRET=test\n');
  const state = path.join(home, 'state');
  fs.mkdirSync(path.join(state, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(state, '.claude', 'feedback-issue-ledger.json'), JSON.stringify({ items: [
    { message_id: 'known', submitter_discord_id: '42', title: '修正', app_name: '営業' },
    { message_id: 'unknown', submitter: '' },
  ] }));
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, payload: JSON.parse(options.body) });
    return { ok: true, status: 200, json: async () => ({ ok: true, dm_message_id: '123', kim_delivered: false, owner_delivered: null }) };
  };
  const args = ['--recipient-only', '--state-home', state, '--message-id', 'known'];
  await main([...args, '--dry'], { home, fetchImpl });
  assert.equal(calls.length, 0);
  await main(args, { home, fetchImpl });
  await main(args, { home, fetchImpl });
  await main(['--recipient-only', '--state-home', state, '--message-id', 'unknown'], { home, fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload.notify_kim, false);
  assert.equal(calls[0].payload.owner_discord_id, undefined);
  assert.ok(calls[0].url.endsWith('/api/feedback-done'));
  const notified = JSON.parse(fs.readFileSync(path.join(state, '.claude', 'feedback-done-notified.json')));
  assert.equal(notified.items[0].dm_message_id, '123');
  assert.equal(fs.existsSync(path.join(home, '.claude', 'feedback-done-notified.json')), false);
});
