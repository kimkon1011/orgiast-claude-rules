import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { dedupeKey, isNearDuplicate, mergeTasks } from './discord-task-digest.mjs';
import { MAIL_NOISE_PATTERNS, gmailThreadLink, preprocessMails, runMailTaskDigest, validateExtractedItem, validatedDeadline } from './mail-task-digest.mjs';

const NOW = new Date('2026-09-03T03:00:00.000Z');
const base = { id: 'm1', threadId: 'th1', date: 'Thu, 03 Sep 2026 10:00:00 +0900', from: '担当者 <staff@example.jp>', subject: '確認依頼', body: '申請内容を確認してください。' };

test('MAIL_NOISE_PATTERNS は各ノイズ条件だけに一致する', () => {
  const samples = [
    'from:会員局 <info-membership@example.jp>\nsubject:更新\nbody:本文',
    'from:mailmagazine@example.jp\nsubject:新着\nbody:本文',
    'from:news@example.jp\nsubject:ニュース\nbody:本文',
    'from:sales@example.jp\nsubject:【PR】製品\nbody:本文',
    'from:event@example.jp\nsubject:【セミナー】開催\nbody:末尾 配信停止',
  ];
  assert.equal(MAIL_NOISE_PATTERNS.length, samples.length);
  MAIL_NOISE_PATTERNS.forEach((pattern, i) => {
    assert.equal(pattern.test(samples[i]), true);
    assert.equal(pattern.test('from:staff@example.jp\nsubject:請求書の確認\nbody:明日までに返信してください'), false);
  });
});

test('preprocessMails は空本文とノイズを落とし同一threadIdの最新1通を残す', () => {
  const old = { ...base, id: 'old', date: '2026-09-01T00:00:00Z' };
  const latest = { ...base, id: 'new', date: '2026-09-02T00:00:00Z' };
  const result = preprocessMails([old, { ...base, id: 'empty', threadId: 'empty', body: '  ' }, { ...base, id: 'ad', threadId: 'ad', from: 'news@example.jp' }, latest]);
  assert.deepEqual(result.map((mail) => mail.id), ['new']);
});

test('件名だけに期日がある場合はdeadlineを空にする', () => {
  const mail = { ...base, subject: '【提出期日：9月4日】確認書', body: '確認書をお送りします。' };
  assert.equal(validatedDeadline('2026-09-04', mail), '');
  assert.equal(validatedDeadline('2026-09-04', { ...mail, body: '9月4日までに返信してください。' }), '2026-09-04');
});

test('完了・御礼で終わるメールはスタブLLMが返しても捨てる', () => {
  const mail = { ...base, body: '資料を拝受いたしました。ありがとうございました。' };
  const item = { i: 0, type: 'タスク', title: '資料確認', action: '資料を確認する', deadline: '', urgency: 1, impact: 1 };
  assert.equal(validateExtractedItem(item, [mail], 'seisaku-team@orgiast.jp'), null);
});

test('link はユーザーを明示した #all/threadId 形式になる', () => {
  const link = gmailThreadLink('seisaku-team@orgiast.jp', 'abc123');
  assert.equal(link, 'https://mail.google.com/mail/u/seisaku-team@orgiast.jp/#all/abc123');
  assert.equal(link.includes('/mail/u/0/'), false);
});

test('dedupeKeyにはthreadIdを渡し別スレッドの同名タスクを潰さない', () => {
  const common = { title: '振込申請を確認', action: '振込申請を確認する' };
  const a = { ...common, channelId: 'thread-a' }, b = { ...common, channelId: 'thread-b' };
  assert.notEqual(dedupeKey(a), dedupeKey(b));
  assert.equal(isNearDuplicate(a, b), false);
});

test('mergeTasks は既存行の状態と実行メモを保持する', () => {
  const row = ['T-0001', '2026-09-01 10:00', 'P2', 50, 'タスク', '請求書確認', '確認する', '', '', '✉ 担当者', '根拠', 'https://mail.google.com/mail/u/a%40b.jp/#all/th1', '進行中', '手入力メモ', '2026-09-01 10:00'];
  const result = mergeTasks([row], [], { now: NOW });
  assert.equal(result.tasks[0].status, '進行中');
  assert.equal(result.tasks[0].memo, '手入力メモ');
});

test('fixture + dry-run + スタブLLMでend-to-endに行を組み立てる', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-task-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fixture = path.join(dir, 'fixture.json');
  fs.writeFileSync(fixture, JSON.stringify({ messages: [{ ...base, body: '振込申請を9月4日までに確認してください。' }] }));
  const logs = [];
  const llm = async () => ({ text: JSON.stringify({ items: [{ i: 0, type: '締切', title: '振込申請の確認', action: '担当者が振込申請を確認する', owner: '', deadline: '2026-09-04', urgency: 3, impact: 3, evidence: '振込申請を9月4日までに確認してください。' }] }) });
  const result = await runMailTaskDigest({ args: ['--fixture', fixture, '--dry-run'], now: NOW, home: dir, llm, existingRows: [], log: (line) => logs.push(line) });
  assert.equal(result.added, 1);
  assert.equal(result.top[0].rank, 'P1');
  const output = JSON.parse(logs[0]);
  assert.equal(output.rows[0][5], '振込申請の確認');
  assert.equal(output.rows[0][9], '✉ 担当者');
  assert.equal(output.rows[0][11].endsWith('#all/th1'), true);
  assert.equal(output.rows[0][12], '未着手');
});
