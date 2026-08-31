import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runEvening } from './evening-digest.mjs';

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'evening-digest-')); }
const response = () => ({ ok: true, status: 204, text: async () => '' });
test('formats no-results case and dry-run stays side-effect free', async () => {
  const dir = home(); const result = await runEvening({ home: dir, now: new Date('2026-08-31T18:00:00'), dryRun: true });
  assert.match(result.message, /特筆事項なし/); assert.equal(fs.existsSync(path.join(dir, '.claude', 'evening-digest-state.json')), false);
});
test('formats results, skips second send, and force sends again', async () => {
  const dir = home(); const now = new Date('2026-08-31T18:00:00'); const resultDir = path.join(dir, '.claude', 'batch-queue');
  fs.mkdirSync(resultDir, { recursive: true });
  fs.writeFileSync(path.join(resultDir, 'results-2026-08-31.jsonl'), `${JSON.stringify({ jobType: 'auto-session-digest', text: '完了しました' })}\n`);
  let sends = 0; const fetchImpl = async () => { sends++; return response(); };
  const first = await runEvening({ home: dir, now, webhookUrl: 'https://example.test/hook', fetchImpl });
  assert.match(first.message, /今日の自動セッション/); assert.match(first.message, /完了しました/);
  assert.equal((await runEvening({ home: dir, now, webhookUrl: 'https://example.test/hook', fetchImpl })).skipped, true);
  await runEvening({ home: dir, now, force: true, webhookUrl: 'https://example.test/hook', fetchImpl });
  assert.equal(sends, 2);
});
test('チャンネル取得失敗でもダイジェスト本体を送る', async () => {
  const dir = home(); let notified = 0;
  const result = await runEvening({
    home: dir, now: new Date('2026-08-31T18:00:00'), token: 'token', channelId: 'channel',
    fetchMessagesImpl: async () => { throw new Error('Discord unavailable'); },
    notifyKimImpl: async (message) => { notified++; assert.doesNotMatch(message, /今日のアラート/); return { delivered: 'dm' }; },
  });
  assert.equal(notified, 1); assert.equal(result.sent, true);
});
test('今日の bot 投稿の 🚨 だけ数え、先頭3件の1行目を載せる', async () => {
  const dir = home(); let sent = '';
  const messages = [
    { timestamp: '2026-08-31T01:00:00Z', author: { bot: true }, content: '🚨 backup failed\ndetail' },
    { timestamp: '2026-08-31T02:00:00Z', author: { bot: false }, content: '🚨 human' },
    { timestamp: '2026-08-31T03:00:00Z', author: { bot: true }, content: 'normal bot' },
    { timestamp: '2026-08-31T04:00:00Z', author: { bot: true }, content: '🚨 fleet stopped' },
    { timestamp: '2026-08-31T05:00:00Z', author: { bot: true }, content: '🚨 webhook dead' },
    { timestamp: '2026-08-31T06:00:00Z', author: { bot: true }, content: '🚨 fourth alert' },
    { timestamp: '2026-08-29T06:00:00Z', author: { bot: true }, content: '🚨 old alert' },
  ];
  await runEvening({
    home: dir, now: new Date('2026-08-31T09:00:00Z'), token: 'token', channelId: 'channel',
    fetchMessagesImpl: async () => ({ messages }),
    notifyKimImpl: async (message) => { sent = message; return { delivered: 'dm' }; },
  });
  assert.match(sent, /🚨 今日のアラート: 4件/);
  assert.match(sent, /backup failed/); assert.match(sent, /fleet stopped/); assert.match(sent, /webhook dead/);
  assert.doesNotMatch(sent, /fourth alert|human|normal bot|old alert|detail/);
});
