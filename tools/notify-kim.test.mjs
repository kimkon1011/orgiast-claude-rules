import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notifyKim } from './notify-kim.mjs';
import { parseHandoff } from './auto-session.mjs';

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'notify-kim-')); }
function response({ ok = true, status = 200, json = {} } = {}) { return { ok, status, json: async () => json }; }

test('token と userId で DM チャンネルを開いて投稿する', async () => {
  const calls = [];
  const result = await notifyKim('hello', { home: home(), token: 'token', userId: 'user', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? response({ json: { id: 'dm-channel' } }) : response();
  } });
  assert.equal(result.delivered, 'dm');
  assert.match(calls[0].url, /users\/@me\/channels$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { recipient_id: 'user' });
  assert.match(calls[1].url, /channels\/dm-channel\/messages$/);
  assert.deepEqual(JSON.parse(calls[1].init.body), { content: 'hello' });
});

test('DM 失敗時は webhook へフォールバックする', async () => {
  const dir = home(); fs.mkdirSync(path.join(dir, '.claude')); fs.writeFileSync(path.join(dir, '.claude', 'orgiast-discord-webhook.txt'), 'https://example.test/webhook');
  const calls = []; const original = console.error; console.error = () => {};
  try {
    const result = await notifyKim('hello', { home: dir, token: 'token', userId: 'user', fetchImpl: async (url) => {
      calls.push(url); return calls.length === 1 ? response({ ok: false, status: 403 }) : response();
    } });
    assert.equal(result.delivered, 'webhook'); assert.equal(calls[1], 'https://example.test/webhook');
  } finally { console.error = original; }
});

test('token がなければ最初から webhook へ送る', async () => {
  const dir = home(); fs.mkdirSync(path.join(dir, '.claude')); fs.writeFileSync(path.join(dir, '.claude', 'orgiast-discord-webhook.txt'), 'https://example.test/webhook');
  const calls = []; const original = console.error; console.error = () => {};
  try {
    const result = await notifyKim('hello', { home: dir, token: '', userId: 'user', fetchImpl: async (url) => { calls.push(url); return response(); } });
    assert.equal(result.delivered, 'webhook'); assert.deepEqual(calls, ['https://example.test/webhook']);
  } finally { console.error = original; }
});

test('通知先がなくても例外にせず stderr 1行で none を返す', async () => {
  const lines = []; const original = console.error; console.error = (line) => lines.push(line);
  try {
    const result = await notifyKim('hello', { home: home(), token: '', userId: '' });
    assert.equal(result.delivered, 'none'); assert.equal(lines.length, 1);
  } finally { console.error = original; }
});

test('2000文字を超える本文を省略表示付きで切る', async () => {
  const bodies = [];
  await notifyKim('あ'.repeat(2_100), { home: home(), token: 'token', userId: 'user', fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? response({ json: { id: 'dm' } }) : response();
  } });
  assert.equal(bodies[1].content.length, 2_000); assert.ok(bodies[1].content.endsWith('…(以下省略)'));
});

test('送信直前に平易化を通す（内部用語が書き換わる）', async () => {
  const bodies = [];
  await notifyKim('▶ 次はこれをやります: feedback-zero-sweep', { home: home(), token: 'token', userId: 'user', plainJaImpl: async () => '次は、社員からの報告をまとめる作業をします。', fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? response({ json: { id: 'dm' } }) : response();
  } });
  assert.equal(bodies[1].content, '次は、社員からの報告をまとめる作業をします。');
});

test('NOTIFY_PLAIN_JA=0 相当（plainJa:false）では本文をそのまま送る', async () => {
  const bodies = [];
  await notifyKim('▶ 次はこれをやります: feedback-zero-sweep', { home: home(), token: 'token', userId: 'user', plainJa: false, plainJaImpl: async () => '書き換え後', fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? response({ json: { id: 'dm' } }) : response();
  } });
  assert.equal(bodies[1].content, '▶ 次はこれをやります: feedback-zero-sweep');
});

function sender(dir, extra = {}) {
  const messages = [];
  return { messages, options: { home: dir, token: 'token', plainJa: false, ...extra, fetchImpl: async (url, init) => {
    if (url.endsWith('/messages')) messages.push(JSON.parse(init.body).content);
    return response({ json: { id: 'dm' } });
  } } };
}
test('原因・対処の欠落は既存TODOへ起票、日時・回数が変わっても24時間抑制', async () => {
  const dir = home(), s = sender(dir);
  assert.equal((await notifyKim('収集失敗 2026-10-22 3回', { ...s.options, now: 0 })).delivered, 'dm');
  assert.match(s.messages[0], /原因:.*\n対処:.*\n自動起票:/);
  assert.equal((await notifyKim('収集失敗 2026-10-23 4回', { ...s.options, now: 1000 })).delivered, 'suppressed');
  assert.equal((await notifyKim('収集失敗 2026-10-23 4回', { ...s.options, now: 86400000 })).delivered, 'dm');
  assert.equal(fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8').match(/1\. \[ \]/g).length, 1);
});
test('原因か対処の片方だけでも起票、両方がある場合は起票不要', async () => {
  for (const tail of ['原因: DNS不通', '対処: 再実行済み', '原因:\n対処: 再実行済み', '原因: DNS不通\n対処: 再実行済み']) {
    const dir = home(), s = sender(dir);
    await notifyKim(`取得失敗\n${tail}`, s.options);
    assert.equal(fs.existsSync(path.join(dir, '.claude/next-session.md')), !tail.startsWith('原因: DNS不通\n対処:'));
  }
});
test('異なる発生元・原因は抑止しない', async () => {
  const s = sender(home());
  for (const [source, cause] of [['a','DNS'], ['b','DNS'], ['a','HTTP 403']])
    assert.equal((await notifyKim('失敗', { ...s.options, source, cause })).delivered, 'dm');
  assert.equal(s.messages.length, 3);
});
test('調査の選択・接続確認を頼まず、起票情報は平易化・長文切り捨て後にも残る', async () => {
  const s = sender(home(), { plainJa: true, plainJaImpl: async () => '長'.repeat(2500) });
  await notifyKim('失敗\nkim に選んでほしい対応:\n1. 原因調査\n2. 停止\n接続して確認してください', s.options);
  assert.ok(s.messages[0].length <= 2000);
  assert.match(s.messages[0], /自動起票:/);
  assert.doesNotMatch(s.messages[0], /選んで|接続して/);
});
test('起票失敗では未修復通知を送らない', async () => {
  const dir = home(); fs.writeFileSync(path.join(dir, '.claude'), 'not a directory');
  const s = sender(dir);
  assert.equal((await notifyKim('失敗', s.options)).delivered, 'none');
  assert.equal(s.messages.length, 0);
});
test('送信失敗後は再送可能、同時呼び出しでも1通知・1起票', async () => {
  const s = sender(home());
  assert.equal((await notifyKim('失敗', { ...s.options, token: '', webhookFallback: false })).delivered, 'none');
  const results = await Promise.all([notifyKim('失敗', s.options), notifyKim('失敗', s.options)]);
  assert.deepEqual(results.map(r => r.delivered).sort(), ['dm', 'suppressed']);
  assert.equal(s.messages.length, 1);
});


test('起票した複数の修復タスクを既存auto-sessionのparserが拾う', async () => {
  const dir = home(), s = sender(dir);
  await notifyKim('領収書失敗', s.options);
  await notifyKim('夜間処理エラー', s.options);
  const parsed = parseHandoff(fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8'));
  assert.equal(parsed.todos.length, 2);
  assert.match(JSON.stringify(parsed.todos), /領収書失敗/);
  assert.match(JSON.stringify(parsed.todos), /夜間処理エラー/);
});

test('人の操作が必要な試行と証拠がある場合は具体的な操作を残す', async () => {
  const s = sender(home());
  await notifyKim('認証失敗\n原因: OAuth同意失効\n対処: 自動更新を試行済み\n試行: 自動更新で再認証\n証拠: invalid_grant\n必要な操作: 管理画面に接続して同意してください', s.options);
  assert.match(s.messages[0], /必要な操作: 管理画面に接続して同意してください/);
  assert.doesNotMatch(s.messages[0], /自動起票:/);
});
