import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, notifyKim } from './notify-kim.mjs';

test('ヘルプは本文と混在しても通知せず終了する', async () => {
  for (const args of [['--help'], ['-h'], ['hello', '--help'], ['-h', 'hello']]) {
    const lines = [];
    const status = await main(args, {
      send: async () => assert.fail('ヘルプ表示で通知してはいけない'),
      log: (line) => lines.push(line),
    });
    assert.equal(status, 0);
    assert.equal(lines.length, 1);
    assert.match(lines[0], /Usage:/);
    assert.match(lines[0], /通知は送信しません/);
  }
});

test('通常の CLI 引数は結合して通知する', async () => {
  const messages = [];
  assert.equal(await main(['hello', 'world'], {
    send: async (message) => messages.push(message),
    log: () => assert.fail('通常の送信でヘルプを表示してはいけない'),
  }), 0);
  assert.deepEqual(messages, ['hello world']);
});

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
  await notifyKim('x'.repeat(2_100), { home: home(), token: 'token', userId: 'user', fetchImpl: async (_url, init) => {
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
