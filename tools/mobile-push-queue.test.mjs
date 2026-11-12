import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendMobilePush, markMobilePushSent, mobilePushInstruction, mobilePushQueueFile, pendingMobilePush } from './lib/mobile-push-queue.mjs';
import { main as cliMain } from './mobile-push-queue.mjs';
import { consumeInbox } from './auto-progress-inbox-hook.mjs';

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mobile-push-queue.mjs');
const hour = 3600 * 1000;

function tempHome(t, prefix = 'mobile-push-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return home;
}

function hookOptions(home) {
  // 宛先解決は通知側（notify-owner）の責務。hook は queue と local owner だけを見る。
  return { home, env: {}, label: 'w018-PC', directory: [], pcMap: { 'w018-PC': { account: 'cr@orgiast.jp', notifyDiscordId: '1557228267566665729' } } };
}

test('appendMobilePush は id/ts/owner/title/body/sent を1行で積む', t => {
  const home = tempHome(t);
  const row = appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '登録タイトル', body: '本文' }, { now: Date.UTC(2026, 10, 6, 0), id: 'fixed-id' });
  assert.equal(row.id, 'fixed-id');
  assert.equal(row.sent, false);
  assert.equal(row.ts, '2026-11-06T00:00:00.000Z');
  const file = mobilePushQueueFile(home);
  assert.equal(file, path.join(home, '.claude', 'mobile-push-queue.jsonl'));
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).title, '登録タイトル');
});

test('長いタイトルは100字に切り詰める', t => {
  const home = tempHome(t);
  const row = appendMobilePush(home, { owner: 'x', title: 'あ'.repeat(150), body: 'b' });
  assert.equal(row.title.length, 100);
});

test('CLI --list は未送信だけを出し --all は全行を出す', t => {
  const home = tempHome(t);
  const sent = appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '送信済み', body: '1' });
  markMobilePushSent(home, [sent.id]);
  appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '未送信', body: '2' });
  const lines = [];
  assert.equal(cliMain(['--list'], { home, out: line => lines.push(line) }), 0);
  assert.deepEqual(lines.map(line => JSON.parse(line).title), ['未送信']);
  lines.length = 0;
  assert.equal(cliMain(['--all'], { home, out: line => lines.push(line) }), 0);
  assert.deepEqual(lines.map(line => JSON.parse(line).sent), [true, false]);
  assert.equal(cliMain([], { home, out: () => {} }), 0); // 引数なしも一覧
});

test('CLI --mark-sent は該当行だけ送信済みにし未知 id は異常終了する', t => {
  const home = tempHome(t);
  const first = appendMobilePush(home, { owner: 'x', title: '1', body: 'b1' });
  const second = appendMobilePush(home, { owner: 'x', title: '2', body: 'b2' });
  let printed = '';
  assert.equal(cliMain(['--mark-sent', first.id], { home, out: value => { printed = value; } }), 0);
  assert.deepEqual(JSON.parse(printed), { marked: [first.id], unknown: [] });
  assert.deepEqual(pendingMobilePush(home).map(row => row.id), [second.id]);
  const rows = fs.readFileSync(mobilePushQueueFile(home), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows[0].sent, true);
  assert.ok(rows[0].sentAt);
  assert.equal(rows[1].sent, false);
  assert.equal(cliMain(['--mark-sent', 'unknown-id'], { home, out: () => {} }), 1);
  assert.throws(() => cliMain(['--mark-sent'], { home, out: () => {} }), /id が1つ必要/);
  assert.throws(() => cliMain(['--bogus'], { home, out: () => {} }), /不明な引数/);
});

test('hook は未送信の push 要求だけを指示に出す（送信済み・他人ownerは出さない）', t => {
  const home = tempHome(t);
  const options = hookOptions(home);
  const sent = appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '送信済みの報告', body: '古い' });
  const unsent = appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '未送信の報告', body: '完了しました' });
  const other = appendMobilePush(home, { owner: 'nishi@orgiast.jp', title: '別PCの持ち主', body: '届かない' });
  markMobilePushSent(home, [sent.id]);
  const context = consumeInbox({ session_id: 's1', hook_event_name: 'UserPromptSubmit' }, options).hookSpecificOutput.additionalContext;
  assert.match(context, /未送信 1 件/);
  assert.match(context, /未送信の報告/);
  assert.match(context, /完了しました/);
  assert.match(context, /PushNotification ツールで送信/);
  assert.ok(context.includes(cliPath));
  assert.ok(context.includes(`--mark-sent ${unsent.id}`));
  assert.ok(!context.includes(sent.id), '送信済みは二度出さない');
  assert.ok(!context.includes(other.id), 'このPCの持ち主でない owner の要求は出さない');
});

test('mark-sent 後は hook が指示を出さない', t => {
  const home = tempHome(t);
  const options = hookOptions(home);
  const item = appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '報告', body: '本文' });
  assert.ok(consumeInbox({ session_id: 's1' }, options).hookSpecificOutput.additionalContext.includes(item.id));
  assert.equal(cliMain(['--mark-sent', item.id], { home, out: () => {} }), 0);
  assert.equal(consumeInbox({ session_id: 's1' }, options), null);
  // 無人セッションでは送信指示を出さず未送信を次の対話に残す
  const next = appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '次の報告', body: '本文2' });
  assert.equal(consumeInbox({ session_id: 's2' }, { ...options, env: { CLAUDE_HEADLESS: '1' } }), null);
  assert.equal(pendingMobilePush(home).map(row => row.id).join(), next.id);
  assert.match(consumeInbox({ session_id: 's2' }, options).hookSpecificOutput.additionalContext, new RegExp(`--mark-sent ${next.id}`));
});

test('24時間超の未送信は1件にまとめ、個別本文を展開しない', t => {
  const home = tempHome(t);
  const now = Date.now();
  appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '26時間前の報告', body: '古い本文' }, { now: now - 26 * hour });
  appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '25時間前の報告', body: '古い本文2' }, { now: now - 25 * hour });
  const fresh = appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '新しい報告', body: '新しい本文' }, { now: now - hour });
  const text = mobilePushInstruction(home, { now, owner: 'cr@orgiast.jp', cliPath });
  assert.match(text, /未送信 3 件/);
  assert.match(text, /1回の通知にまとめる/);
  assert.match(text, /古い未送信 2 件/);
  assert.match(text, /26時間前の報告/); // 最古タイトルのみ要約に出す
  assert.ok(!text.includes('25時間前の報告'), 'まとめ対象の個別タイトルは展開しない');
  assert.ok(!text.includes('古い本文2'));
  assert.match(text, /新しい報告/);
  assert.match(text, /新しい本文/);
  const stale = pendingMobilePush(home).filter(row => Date.parse(row.ts) < now - 24 * hour);
  assert.ok(text.includes(stale.map(row => `--mark-sent ${row.id}`).join(' ')), 'まとめ分の mark-sent を1コマンドで示す');
  assert.ok(text.includes(`--mark-sent ${fresh.id}`));
});

test('表示上限を超える未送信も1件にまとめて指示が膨らまない', t => {
  const home = tempHome(t);
  const now = Date.now();
  for (let i = 0; i < 12; i++) appendMobilePush(home, { owner: 'cr@orgiast.jp', title: `報告${String(i).padStart(2, '0')}`, body: `本文${String(i).padStart(2, '0')}` }, { now: now - i * 60 * 1000 }); // i=0 が最新
  const text = mobilePushInstruction(home, { now, owner: 'cr@orgiast.jp', cliPath });
  assert.match(text, /未送信 12 件/);
  assert.match(text, /古い未送信 2 件（最古 報告11）/);
  assert.ok(text.includes('報告00'), '最新の10件は個別表示');
  assert.ok(!text.includes('本文10'), '上限外の古い報告は本文を展開しない');
  assert.ok(!text.includes('本文11'));
  assert.ok(text.indexOf('報告00') < text.indexOf('報告02'), '個別表示は新しい順');
});

test('本文の改行は1行に整形して指示に出す', t => {
  const home = tempHome(t);
  appendMobilePush(home, { owner: 'cr@orgiast.jp', title: 'タイトル', body: '1行目\n2行目\n\n3行目' });
  const text = mobilePushInstruction(home, { owner: 'cr@orgiast.jp', cliPath });
  assert.ok(text.includes('1行目 2行目 3行目'));
});
