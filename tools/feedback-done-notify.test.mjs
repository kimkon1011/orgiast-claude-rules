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
