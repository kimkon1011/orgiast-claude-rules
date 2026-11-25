import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendMobilePush, ATTEMPT_LIMIT, ESCALATION_THRESHOLD, markMobilePushAttempt, markMobilePushSent, mobilePushInstruction, mobilePushQueueFile, pendingMobilePush, readMobilePushQueue, sweepMobilePushQueue } from './lib/mobile-push-queue.mjs';
import { main as cliMain } from './mobile-push-queue.mjs';
import { consumeInbox } from './auto-progress-inbox-hook.mjs';

const cliPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mobile-push-queue.mjs');
const hour = 3600 * 1000;

test('formatting pending instructions is repeatable and leaves queue and emission state untouched', t => {
  const home = tempHome(t);
  const options = { owner: 'test', cliPath, sessionId: 'push-dedupe' };
  appendMobilePush(home, { owner: 'test', title: '進捗1', body: '確認中' });
  const before = fs.readFileSync(mobilePushQueueFile(home), 'utf8');
  const first = mobilePushInstruction(home, options);
  assert.match(first, /未送信 1 件/);
  assert.equal(mobilePushInstruction(home, options), first);
  assert.equal(fs.readFileSync(mobilePushQueueFile(home), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(home, '.claude', 'state', 'context-dedupe')), false);
  appendMobilePush(home, { owner: 'test', title: '進捗2', body: '完了' });
  const next = mobilePushInstruction(home, options);
  assert.match(next, /未送信 2 件/);
  assert.equal(mobilePushInstruction(home, options), next);
  assert.match(mobilePushInstruction(home, { ...options, sessionId: 'other' }), /未送信 2 件/);
});

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

test('markMobilePushAttempt は attempts と lastAttemptAt を更新して本文を未送信のまま残す', t => {
  const home = tempHome(t);
  const item = appendMobilePush(home, { owner: 'x', title: '報告', body: '本文' }, { id: 'attempt-id' });
  const now = Date.UTC(2026, 10, 23, 3, 5);
  assert.deepEqual(markMobilePushAttempt(home, [item.id], { now }), { bumped: [item.id], escalated: [], unknown: [] });
  let row = readRow(home, item.id);
  assert.equal(row.attempts, 1);
  assert.equal(row.lastAttemptAt, new Date(now).toISOString());
  assert.equal(row.sent, false);
  markMobilePushAttempt(home, [item.id], { now: now + 1000 });
  row = readRow(home, item.id);
  assert.equal(row.attempts, 2);
  assert.equal(row.sent, false);
  assert.deepEqual(markMobilePushAttempt(home, ['unknown-id']), { bumped: [], escalated: [], unknown: ['unknown-id'] });
});

test('CLI --mark-attempt は試行回数を増やし mark-sent との併用を拒否する', t => {
  const home = tempHome(t);
  const item = appendMobilePush(home, { owner: 'x', title: '報告', body: '本文' });
  let printed = '';
  assert.equal(cliMain(['--mark-attempt', item.id], { home, out: value => { printed = value; } }), 0);
  assert.deepEqual(JSON.parse(printed), { bumped: [item.id], escalated: [], unknown: [] });
  assert.equal(readRow(home, item.id).attempts, 1);
  assert.throws(() => cliMain(['--mark-sent', item.id, '--mark-attempt', item.id], { home, out: () => {} }), /同時に指定できません/);
  assert.throws(() => cliMain(['--mark-attempt'], { home, out: () => {} }), /id が1つ必要/);
});

function readRow(home, id) {
  return fs.readFileSync(mobilePushQueueFile(home), 'utf8').trim().split('\n').map(JSON.parse).find(row => row.id === id);
}

test('4回の attempt では escalation されない', t => {
  const home = tempHome(t);
  const item = appendMobilePush(home, { owner: 'x', title: '報告', body: '本文' }, { id: 'esc-test-1' });
  for (let i = 0; i < 4; i++) {
    const result = markMobilePushAttempt(home, [item.id]);
    assert.equal(result.escalated.length, 0);
    assert.equal(result.bumped.length, 1);
  }
  const row = readRow(home, item.id);
  assert.equal(row.attempts, 4);
  assert.equal(row.sent, false);
  assert.equal(pendingMobilePush(home).length, 1);
});

test('5回目の attempt で escalation の escalated が返る', t => {
  const home = tempHome(t);
  const item = appendMobilePush(home, { owner: 'x', title: '報告', body: '本文' }, { id: 'esc-test-2' });
  for (let i = 0; i < 4; i++) markMobilePushAttempt(home, [item.id]);
  const result = markMobilePushAttempt(home, [item.id]);
  assert.equal(result.bumped.length, 1);
  assert.equal(result.escalated.length, 1);
  assert.equal(result.escalated[0].id, item.id);
  assert.equal(result.escalated[0].attempts, 5);
  const row = readRow(home, item.id);
  assert.equal(row.attempts, 5);
  assert.equal(row.sent, false);
});

test('CLI --mark-attempt 経由で escalation された項目は kim-inbox spool に積まれる', t => {
  const home = tempHome(t);
  const item = appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '通知タイトル', body: '通知本文です' }, { id: 'esc-test-3' });
  for (let i = 0; i < 4; i++) markMobilePushAttempt(home, [item.id]);

  let printed = '';
  assert.equal(cliMain(['--mark-attempt', item.id], { home, out: line => { printed = line; } }), 0);
  const result = JSON.parse(printed);
  assert.equal(result.bumped.length, 1);
  assert.equal(result.escalated.length, 1);
  assert.equal(result.escalated[0].id, item.id);
  assert.equal(result.spooled, 1);

  const spoolDir = path.join(home, '.claude', 'kim-inbox', 'spool');
  assert.ok(fs.existsSync(spoolDir), 'spool ディレクトリが必要');
  const spoolFiles = fs.readdirSync(spoolDir).filter(f => f.endsWith('.json'));
  assert.ok(spoolFiles.length >= 1, 'spool ファイルが必要');

  const spoolContent = JSON.parse(fs.readFileSync(path.join(spoolDir, spoolFiles[0]), 'utf8'));
  assert.match(spoolContent.text, /【スマホ通知が送れなかったため転記】/);
  assert.match(spoolContent.text, /通知本文です/);
  assert.equal(spoolContent.kind, 'info');
  assert.equal(spoolContent.source, 'mobile-push-escalation');
});

test('同じ本文の escalation は1件にまとめて spool される', t => {
  const home = tempHome(t);
  const item1 = appendMobilePush(home, { owner: 'x', title: 'タイトル1', body: '同じ本文' }, { id: 'dedupe-a' });
  const item2 = appendMobilePush(home, { owner: 'x', title: 'タイトル2', body: '同じ本文' }, { id: 'dedupe-b' });
  for (let i = 0; i < 4; i++) markMobilePushAttempt(home, [item1.id, item2.id]);

  let printed = '';
  assert.equal(cliMain(['--mark-attempt', item1.id, '--mark-attempt', item2.id], { home, out: line => { printed = line; } }), 0);
  const result = JSON.parse(printed);
  assert.equal(result.bumped.length, 2);
  assert.equal(result.escalated.length, 2);
  assert.equal(result.spooled, 1);

  const spoolDir = path.join(home, '.claude', 'kim-inbox', 'spool');
  const spoolFiles = fs.readdirSync(spoolDir).filter(f => f.endsWith('.json'));
  assert.equal(spoolFiles.length, 1);
});

test('hook は未送信の push 要求だけを指示に出す（送信済み・他人ownerは出さない）', t => {
  const home = tempHome(t);
  const options = hookOptions(home);
  const now = Date.now();
  const sent = appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '送信済みの報告', body: '古い' }, { now });
  const unsent = appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '未送信の報告', body: '完了しました' }, { now });
  const other = appendMobilePush(home, { owner: 'nishi@orgiast.jp', title: '別PCの持ち主', body: '届かない' }, { now });
  markMobilePushSent(home, [sent.id]);
  const context = consumeInbox({ session_id: 's1', hook_event_name: 'UserPromptSubmit' }, { ...options, now }).hookSpecificOutput.additionalContext;
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
  // TTL expire されないように、現在時刻から72時間以内の時間を使用
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
  // TTL expire されないように、現在時刻から72時間以内の時間を使用
  for (let i = 0; i < 12; i++) appendMobilePush(home, { owner: 'cr@orgiast.jp', title: `報告${String(i).padStart(2, '0')}`, body: `本文${String(i).padStart(2, '0')}` }, { now: now - i * 60 * 1000 }); // i=0 が最新
  const text = mobilePushInstruction(home, { now, owner: 'cr@orgiast.jp', cliPath });
  assert.match(text, /未送信 12 件/);
  assert.match(text, /古い未送信 2 件（最古 報告11）/);
  assert.ok(text.includes('報告00'), '最新の10件は個別表示');
  assert.ok(!text.includes('本文10'), '上限外の古い報告は本文を展開しない');
  assert.ok(!text.includes('本文11'));
  assert.ok(text.indexOf('報告00') < text.indexOf('報告02'), '個別表示は新しい順');
});

test('試行上限に達した未送信は個別表示せずまとめ行に数え mark-attempt を案内する', t => {
  const home = tempHome(t);
  const now = Date.now();
  // TTL expire されないように、現在時刻から72時間以内の時間を使用
  const limited = appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '上限到達', body: '個別には出さない本文' }, { now });
  for (let i = 0; i < ATTEMPT_LIMIT; i++) markMobilePushAttempt(home, [limited.id], { now: now + i });
  const fresh = appendMobilePush(home, { owner: 'cr@orgiast.jp', title: '新着', body: '新着本文' }, { now });
  const text = mobilePushInstruction(home, { now, owner: 'cr@orgiast.jp', cliPath });
  assert.match(text, /古い未送信 1 件/);
  assert.ok(!text.includes('個別には出さない本文'));
  assert.match(text, /新着本文/);
  assert.ok(text.includes(`--mark-attempt ${limited.id}`));
  assert.ok(text.includes(`--mark-attempt ${fresh.id}`));
});

test('本文の改行は1行に整形して指示に出す', t => {
  const home = tempHome(t);
  const now = Date.now();
  // TTL expire されないように、現在時刻から72時間以内の時間を使用
  appendMobilePush(home, { owner: 'cr@orgiast.jp', title: 'タイトル', body: '1行目\n2行目\n\n3行目' }, { now });
  const text = mobilePushInstruction(home, { owner: 'cr@orgiast.jp', cliPath, now });
  assert.ok(text.includes('1行目 2行目 3行目'));
});

test('重複圧縮: 同じ title+body のエントリは1つにまとまり occurrences が増える', async t => {
  const home = tempHome(t);
  const now = Date.now();

  // 同じ内容のエントリを3回追加
  appendMobilePush(home, { owner: 'test', title: '重複タイトル', body: '重複本文' }, { now: now - 1000 });
  appendMobilePush(home, { owner: 'test', title: '重複タイトル', body: '重複本文' }, { now: now });
  appendMobilePush(home, { owner: 'test', title: '重複タイトル', body: '重複本文' }, { now: now + 1000 });

  // sweep を実行
  const result = await sweepMobilePushQueue(home);
  assert.equal(result.deduplicated, 2); // 2件が圧縮される

  const queue = readMobilePushQueue(home);
  assert.equal(queue.length, 1); // エントリ数は1つ

  const item = queue[0];
  assert.equal(item.title, '重複タイトル');
  assert.equal(item.body, '重複本文');
  assert.equal(item.occurrences, 3);
  assert.ok(item.lastQueuedAt); // lastQueuedAt が更新されている
});

test('TTL expire: 期限切れのエントリは status: "expired" になるが削除はしない', async t => {
  const home = tempHome(t);
  const now = Date.now();
  const ttlMs = 72 * 60 * 60 * 1000; // 72時間

  // 期限切れのエントリ
  appendMobilePush(home, { owner: 'test', title: '古いエントリ', body: '本文' }, { now: now - ttlMs - 1000 });
  // 期限内のエントリ
  appendMobilePush(home, { owner: 'test', title: '新しいエントリ', body: '本文' }, { now: now - 1000 });

  // sweep を実行
  const result = await sweepMobilePushQueue(home, { now });
  assert.equal(result.expired, 1); // 1件が expire される

  const queue = readMobilePushQueue(home);
  assert.equal(queue.length, 2); // エントリ数は2つ（削除されていない）

  const expiredItem = queue.find(item => item.title === '古いエントリ');
  const validItem = queue.find(item => item.title === '新しいエントリ');

  assert.ok(expiredItem);
  assert.equal(expiredItem.status, 'expired');
  assert.ok(expiredItem.expiredAt);

  assert.ok(validItem);
  assert.notEqual(validItem.status, 'expired');

  // pendingMobilePush からは expired なものは除外される
  const pending = pendingMobilePush(home);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, '新しいエントリ');
});

test('CLI --sweep --dry-run はファイルを変更しない', async t => {
  const home = tempHome(t);
  const now = Date.now();
  const ttlMs = 72 * 60 * 60 * 1000; // 72時間

  // 期限切れのエントリ
  const expiredItem = appendMobilePush(home, { owner: 'test', title: '古いエントリ', body: '本文' }, { now: now - ttlMs - 1000 });
  // 同じ内容のエントリを2回追加（重複圧縮対象）
  const firstItem = appendMobilePush(home, { owner: 'test', title: '重複タイトル', body: '重複本文' }, { now: now - 1000 });
  const secondItem = appendMobilePush(home, { owner: 'test', title: '重複タイトル', body: '重複本文' }, { now: now });

  // dry-run で sweep を実行前のファイル内容を保存
  const beforeContent = fs.readFileSync(mobilePushQueueFile(home), 'utf8');

  // dry-run で sweep を実行
  let output = '';
  const exitCode = cliMain(['--sweep', '--dry-run'], { home, out: (line) => output += line });

  assert.equal(exitCode, 0);
  const result = JSON.parse(output);
  assert.equal(result.deduplicated, 1);
  assert.equal(result.expired, 1);

  // ファイルの中身が変わっていないことを確認
  const afterContent = fs.readFileSync(mobilePushQueueFile(home), 'utf8');
  assert.equal(afterContent, beforeContent);

  // 再度通常の sweep を実行して、実際に変更されることを確認
  cliMain(['--sweep'], { home, out: () => {} });

  const queue = readMobilePushQueue(home);
  const expiredQueueItem = queue.find(item => item.id === expiredItem.id);
  const dedupedQueueItem = queue.find(item => item.title === '重複タイトル');

  assert.ok(expiredQueueItem);
  assert.equal(expiredQueueItem.status, 'expired');
  assert.ok(dedupedQueueItem);
  assert.equal(dedupedQueueItem.occurrences, 2);
});
