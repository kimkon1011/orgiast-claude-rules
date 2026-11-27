import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { formatDm, runWatcher } from './reply-notify.mjs';

const watch = { id: 'test', label: 'テスト顧客', user: 'seisaku-team@orgiast.jp', query: 'x', notify: 'satou@orgiast.jp', until: '2027-01-31' };
const message = { id: 'm1', threadId: 't1', internalDate: String(Date.parse('2026-11-27T01:00:00Z')), from: 'customer@example.com', subject: '返信', body: '本文' };
async function fixture(state = { notifiedMessageIds: [] }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reply-notify-test-'));
  return { state, config: { watches: [watch] }, stateFile: path.join(dir, 'state.json'), logFile: path.join(dir, 'log.jsonl'), output: () => {} };
}

test('通知本文に受信情報とGmailリンクを含む', () => {
  const body = formatDm(watch, message);
  assert.match(body, /佐藤さん/u); assert.match(body, /customer@example\.com/u); assert.match(body, /#all\/t1/u);
});
test('新着をDMし、成功時だけ状態に記録する', async () => {
  let sent = 0; const options = await fixture();
  const result = await runWatcher({ ...options, now: new Date('2026-11-27T02:00:00Z'), search: async () => [message], sendDm: async () => { sent++; return { delivered: true, code: 0 }; }, addInbox: async () => {} });
  assert.equal(sent, 1); assert.deepEqual(result.state.notifiedMessageIds, ['m1']); assert.equal(result.summary.notified, 1);
});
test('DM失敗なら状態に記録せず、次回再試行できる', async () => {
  const options = await fixture();
  const result = await runWatcher({ ...options, now: new Date('2026-11-27T02:00:00Z'), search: async () => [message], sendDm: async () => ({ delivered: false, code: 1 }) });
  assert.deepEqual(result.state.notifiedMessageIds, []); assert.equal(result.summary.failed, 1);
});
test('期限超過と既通知は送信しない', async () => {
  let calls = 0; const expired = await fixture();
  await runWatcher({ ...expired, now: new Date('2027-02-01T03:00:00Z'), search: async () => { calls++; return [message]; }, sendDm: async () => { calls++; return { delivered: true }; } });
  const known = await fixture({ notifiedMessageIds: ['m1'] });
  await runWatcher({ ...known, now: new Date('2026-11-27T02:00:00Z'), search: async () => [message], sendDm: async () => { calls++; return { delivered: true }; } });
  assert.equal(calls, 0);
});
