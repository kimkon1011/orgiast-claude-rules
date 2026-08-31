import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runGemini } from './gemini-mcp.mjs';

const successResponse = (parts = [{ text: 'ok' }]) => new Response(JSON.stringify({
  candidates: [{ content: { parts } }],
}), { status: 200 });

test('200 応答は text を持つ parts だけ連結する', async () => {
  const result = await runGemini('prompt', undefined, {
    env: { GEMINI_API_KEY: 'test-key' },
    fetchImpl: async () => successResponse([
      { text: '前半' },
      { thoughtSignature: 'x' },
      { text: '後半' },
    ]),
  });
  assert.deepEqual(result, { ok: true, text: '前半後半' });
});

test('モデルは未指定なら既定値、指定時は指定値を URL に使う', async () => {
  const urls = [];
  const fetchImpl = async (url) => { urls.push(url); return successResponse(); };
  const options = { env: { GEMINI_API_KEY: 'test-key' }, fetchImpl };
  await runGemini('default', undefined, options);
  await runGemini('custom', 'gemini-test-model', options);
  assert.match(urls[0], /\/models\/gemini-3\.6-flash:generateContent$/);
  assert.match(urls[1], /\/models\/gemini-test-model:generateContent$/);
});

test('429 は本文を返し、googleSearch の場合だけ無料枠の注記を付ける', async () => {
  const fetchImpl = async () => new Response('quota exceeded', { status: 429 });
  const base = { env: { GEMINI_API_KEY: 'test-key' }, fetchImpl };
  const chat = await runGemini('prompt', undefined, base);
  const search = await runGemini('prompt', undefined, { ...base, googleSearch: true });
  assert.equal(chat.ok, false);
  assert.match(chat.text, /quota exceeded/);
  assert.doesNotMatch(chat.text, /無料枠では使えません/);
  assert.equal(search.ok, false);
  assert.match(search.text, /quota exceeded/);
  assert.match(search.text, /無料枠では使えません/);
});

test('API キーが無ければ fetch を呼ばずエラーを返す', (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-mcp-empty-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  let calls = 0;
  return runGemini('prompt', undefined, {
    env: {},
    homeDir,
    fetchImpl: async () => { calls++; return successResponse(); },
  }).then((result) => {
    assert.equal(calls, 0);
    assert.deepEqual(result, { ok: false, text: 'GEMINI_API_KEY が見つかりません' });
  });
});

test('homeDir 配下の .gemini/.env から API キーを読む', async (t) => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-mcp-env-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(homeDir, '.gemini'));
  fs.writeFileSync(path.join(homeDir, '.gemini', '.env'), 'GEMINI_API_KEY=test-key\n');
  let receivedKey;
  const result = await runGemini('prompt', undefined, {
    env: {},
    homeDir,
    fetchImpl: async (_url, init) => { receivedKey = init.headers['x-goog-api-key']; return successResponse(); },
  });
  assert.equal(receivedKey, 'test-key');
  assert.deepEqual(result, { ok: true, text: 'ok' });
});

test('指定時間を超えると fetch を abort して timeout を返す', async () => {
  let aborted = false;
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      aborted = true;
      reject(new Error('aborted'));
    }, { once: true });
  });
  const result = await runGemini('prompt', undefined, {
    env: { GEMINI_API_KEY: 'test-key', ORGIAST_GEMINI_TIMEOUT_MS: '5' },
    fetchImpl,
  });
  assert.equal(aborted, true);
  assert.equal(result.ok, false);
  assert.match(result.text, /timeout/);
});

test('リクエスト body は googleSearch の場合だけ検索ツールを含む', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return successResponse(); };
  const base = { env: { GEMINI_API_KEY: 'test-key' }, fetchImpl };
  await runGemini('chat prompt', undefined, base);
  await runGemini('search prompt', undefined, { ...base, googleSearch: true });
  assert.deepEqual(bodies[0], { contents: [{ parts: [{ text: 'chat prompt' }] }] });
  assert.deepEqual(bodies[1], {
    contents: [{ parts: [{ text: 'search prompt' }] }],
    tools: [{ google_search: {} }],
  });
});
