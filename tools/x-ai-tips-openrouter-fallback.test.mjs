import test from 'node:test';
import assert from 'node:assert/strict';
import { callOpenRouterGrok, classifyApiError } from './x-ai-tips-collect.mjs';

test('403 は共有クライアントで OpenRouter grok に同じプロンプトを送る', async () => {
  assert.equal(classifyApiError(403, 'insufficient credits'), 'credit-blocked');
  let request;
  const result = await callOpenRouterGrok('same prompt', {
    key: 'test-only',
    fetchFn: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"items":[]}' } }], usage: {} }));
    },
  });
  assert.equal(request.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(request.body.model, 'x-ai/grok-4.6');
  assert.equal(request.body.messages[1].content, 'same prompt');
  assert.equal(result.text, '{"items":[]}');
});

test('401 は credit fallback 対象に分類しない', () => {
  assert.equal(classifyApiError(401, 'invalid api key'), 'fatal');
});
