import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLlm, REPLY_CHAIN, IMAGE_REPLY_CHAIN } from './autoreply-llm.mjs';

function homeWithKeys() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autoreply-llm-'));
  fs.mkdirSync(path.join(home, '.claude'));
  for (const [file, key] of [['groq.env', 'GROQ_API_KEY'], ['openrouter.env', 'OPENROUTER_API_KEY'], ['gemini.env', 'GEMINI_API_KEY'], ['genspark-proxy.env', 'GSK_PROXY_KEY']]) {
    fs.writeFileSync(path.join(home, '.claude', file), `${key}=test\n`);
  }
  return home;
}

test('REPLY_CHAIN は gpt-oss → OpenRouter deepseek → gemini → kimi', () => {
  assert.deepEqual(REPLY_CHAIN.map((item) => `${item.provider}:${item.model}`), [
    'groq:openai/gpt-oss-120b',
    'openrouter:openai/gpt-oss-120b',
    'deepseek:deepseek-v4-flash',
    'gemini:gemini-3.6-flash',
    'kimi:kimi-k3',
    'genspark:gpt-5.6-luna',
  ]);
  assert.deepEqual(IMAGE_REPLY_CHAIN.map((item) => `${item.provider}:${item.model}`), [
    'gemini:gemini-3.6-flash',
    'openrouter:google/gemini-3.7-flash',
    'kimi:kimi-k3',
  ]);
});

test('直APIが402でも gpt-oss を kimi-k3 より先に使う', async () => {
  const home = homeWithKeys();
  const calls = [];
  const llm = createLlm({
    home, sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), model: body.model });
      if (/googleapis/.test(url) || /api\.deepseek\.com/.test(url)) return new Response('no balance', { status: 402 });
      if (/groq/.test(url)) return new Response('no balance', { status: 402 });
      if (body.model === 'openai/gpt-oss-120b') return new Response(JSON.stringify({ choices: [{ message: { content: '日本語の返信です' } }] }), { status: 200 });
      if (/kimi/.test(body.model)) return new Response(JSON.stringify({ choices: [{ message: { content: 'kimi' } }] }), { status: 200 });
      return new Response('no', { status: 402 });
    },
  });
  assert.equal(await llm({ category: 'jp_reply', system: 'sys', input: { question: '質問' } }), '日本語の返信です');
  assert.match(calls[0].url, /groq/);
  assert.equal(calls.some((call) => /kimi/.test(call.model)), false);
  assert.ok(calls.some((call) => call.model === 'openai/gpt-oss-120b' && /openrouter/.test(call.url)));
  fs.rmSync(home, { recursive: true, force: true });
});

test('gpt-oss が失敗しても deepseek-v4-flash を kimi-k3 より先に使う', async () => {
  const home = homeWithKeys();
  const calls = [];
  const llm = createLlm({
    home, sleepImpl: async () => {},
    fetchImpl: async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url: String(url), model: body.model });
      if (/googleapis/.test(url) || /api\.deepseek\.com/.test(url) || /groq/.test(url)) return new Response('no balance', { status: 402 });
      if (body.model === 'openai/gpt-oss-120b') return new Response('no balance', { status: 402 });
      if (/deepseek-v4-flash/.test(body.model)) return new Response(JSON.stringify({ choices: [{ message: { content: 'deepseek返信' } }] }), { status: 200 });
      if (/kimi/.test(body.model)) return new Response(JSON.stringify({ choices: [{ message: { content: 'kimi' } }] }), { status: 200 });
      return new Response('no', { status: 402 });
    },
  });
  assert.equal(await llm({ category: 'jp_reply', system: 'sys', input: { question: '質問' } }), 'deepseek返信');
  assert.equal(calls.some((call) => /kimi/.test(call.model)), false);
  assert.ok(calls.some((call) => /deepseek-v4-flash/.test(call.model) && /openrouter/.test(call.url)));
  const deepseekAt = calls.findIndex((call) => /deepseek-v4-flash/.test(call.model));
  const geminiAt = calls.findIndex((call) => /googleapis/.test(call.url));
  assert.ok(deepseekAt >= 0);
  assert.ok(geminiAt === -1 || deepseekAt < geminiAt);
  fs.rmSync(home, { recursive: true, force: true });
});
