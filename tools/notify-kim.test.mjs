import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notifyKim } from './notify-kim.mjs';

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
