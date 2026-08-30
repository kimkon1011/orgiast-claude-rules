import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './web-search.mjs';

const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'web-search-test-'));
process.env.ORGIAST_HOME = isolatedHome;
test.after(() => fs.rmSync(isolatedHome, { recursive: true, force: true }));

function outputSink() {
  let value = '';
  return { stream: { write(chunk) { value += chunk; } }, read: () => value };
}

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) };
}

test('executed_tools の URL を重複なく既定出力へ列挙する', async () => {
  const out = outputSink();
  const fetchImpl = async () => response({ choices: [{ message: { content: '回答', executed_tools: [
    { arguments: '{"url":"https://example.com/a"}' },
    { type: 'search', results: [{ url: 'https://example.com/a' }, { snippet: '出典 https://example.org/b' }] },
  ] } }] });
  const code = await runCli(['質問', '--provider', 'groq'], { apiKey: 'test', fetchImpl, stdout: out.stream, stderr: outputSink().stream });
  assert.equal(code, 0);
  assert.match(out.read(), /参照した URL:/);
  assert.equal((out.read().match(/https:\/\/example\.com\/a/g) ?? []).length, 1);
  assert.match(out.read(), /https:\/\/example\.org\/b/);
});

test('--json は query, model, answer, urls を含む1行JSONを返す', async () => {
  const out = outputSink();
  const fetchImpl = async () => response({ choices: [{ message: { content: '答え', executed_tools: [{ arguments: '{"url":"https://example.com/"}' }] } }] });
  const code = await runCli(['検索語', '--provider', 'groq', '--json'], { apiKey: 'test', fetchImpl, stdout: out.stream, stderr: outputSink().stream });
  assert.equal(code, 0);
  assert.equal(out.read().trim().split('\n').length, 1);
  const parsed = JSON.parse(out.read());
  assert.deepEqual({ query: parsed.query, model: parsed.model, answer: parsed.answer, urls: parsed.urls }, {
    query: '検索語', model: 'groq/compound-mini', answer: '答え', urls: ['https://example.com/'],
  });
});

test('HTTP 429 はリトライせず exit 1 で再実行を促す', async () => {
  const err = outputSink();
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return response({ error: 'rate limit' }, 429); };
  const code = await runCli(['質問', '--provider', 'groq'], { apiKey: 'test', fetchImpl, stdout: outputSink().stream, stderr: err.stream });
  assert.equal(code, 1);
  assert.equal(calls, 1);
  assert.match(err.read(), /HTTP 429/);
  assert.match(err.read(), /時間をおいて再実行/);
});

test('キーが無いと exit 2 で設定場所を案内する', async () => {
  const err = outputSink();
  const code = await runCli(['質問'], { env: {}, homeDir: '/存在しないテスト用パス', stdout: outputSink().stream, stderr: err.stream });
  assert.equal(code, 2);
  assert.match(err.read(), /環境変数/);
  assert.match(err.read(), /~\/\.claude\/groq\.env/);
});

test('Gemini が成功したら Groq を呼ばない', async () => {
  const out = outputSink();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return response({ candidates: [{ content: { parts: [{ text: 'Gemini回答' }] } }] });
  };
  const code = await runCli(['質問', '--json'], {
    geminiApiKey: 'gemini-test', groqApiKey: 'groq-test', fetchImpl,
    stdout: out.stream, stderr: outputSink().stream,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /generativelanguage\.googleapis\.com/);
  assert.equal(JSON.parse(out.read()).provider, 'gemini');
});

test('Gemini 429 はリトライせず Groq へフォールバックする', async () => {
  const out = outputSink();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('generativelanguage.googleapis.com')) return response({ error: 'rate limit' }, 429);
    return response({ choices: [{ message: { content: 'Groq回答' } }] });
  };
  const code = await runCli(['質問', '--json'], {
    geminiApiKey: 'gemini-test', groqApiKey: 'groq-test', fetchImpl,
    stdout: out.stream, stderr: outputSink().stream,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /api\.groq\.com/);
  assert.equal(JSON.parse(out.read()).provider, 'groq');
});

test('Gemini が 200 でも本文が空なら Groq へフォールバックする', async () => {
  const out = outputSink();
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('generativelanguage.googleapis.com')) {
      return response({ candidates: [{ content: { parts: [{ text: '   ' }] } }] });
    }
    return response({ choices: [{ message: { content: 'Groq回答' } }] });
  };
  const code = await runCli(['質問', '--json'], {
    geminiApiKey: 'gemini-test', groqApiKey: 'groq-test', fetchImpl,
    stdout: out.stream, stderr: outputSink().stream,
  });
  assert.equal(code, 0);
  assert.equal(calls.length, 2);
  assert.equal(JSON.parse(out.read()).provider, 'groq');
});

test('--provider gemini で本文が空なら exit 1 になり理由を出す', async () => {
  const err = outputSink();
  const fetchImpl = async () => response({ candidates: [] });
  const code = await runCli(['質問', '--provider', 'gemini'], {
    geminiApiKey: 'test', fetchImpl,
    stdout: outputSink().stream, stderr: err.stream,
  });
  assert.equal(code, 1);
  assert.match(err.read(), /本文が空/);
});

test('groundingChunks のタイトル付き URL を重複なく抽出する', async () => {
  const out = outputSink();
  const fetchImpl = async () => response({ candidates: [{
    content: { parts: [{ text: '回答' }] },
    groundingMetadata: { groundingChunks: [
      { web: { uri: 'https://example.com/a', title: '資料A' } },
      { web: { uri: 'https://example.com/a', title: '重複' } },
      { web: { uri: 'https://example.org/b', title: '資料B' } },
    ] },
  }] });
  const code = await runCli(['質問', '--provider', 'gemini'], {
    geminiApiKey: 'test', fetchImpl, stdout: out.stream, stderr: outputSink().stream,
  });
  assert.equal(code, 0);
  assert.match(out.read(), /資料A — https:\/\/example\.com\/a/);
  assert.match(out.read(), /資料B — https:\/\/example\.org\/b/);
  assert.equal((out.read().match(/https:\/\/example\.com\/a/g) ?? []).length, 1);
});

test('Gemini と Groq の両方が失敗したら両理由を出して exit 1', async () => {
  const err = outputSink();
  const fetchImpl = async (url) => url.includes('generativelanguage.googleapis.com')
    ? response({ error: 'gemini down' }, 500)
    : response({ error: 'groq too large' }, 413);
  const code = await runCli(['質問'], {
    geminiApiKey: 'gemini-test', groqApiKey: 'groq-test', fetchImpl,
    stdout: outputSink().stream, stderr: err.stream,
  });
  assert.equal(code, 1);
  assert.match(err.read(), /Gemini API HTTP 500/);
  assert.match(err.read(), /Groq API HTTP 413/);
});

test('Gemini parts の text を持たない要素を無視して本文を連結する', async () => {
  const out = outputSink();
  const fetchImpl = async () => response({ candidates: [{ content: { parts: [
    { text: '前半' }, { thoughtSignature: '署名' }, { text: '後半' },
  ] } }] });
  const code = await runCli(['質問', '--provider', 'gemini', '--json'], {
    geminiApiKey: 'test', fetchImpl, stdout: out.stream, stderr: outputSink().stream,
  });
  assert.equal(code, 0);
  assert.equal(JSON.parse(out.read()).answer, '前半後半');
});

test('Gemini 成功時に token と grounded を台帳へ追記する', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-search-ledger-'));
  try {
    const usageFile = path.join(temp, 'executor-usage.jsonl');
    const fetchImpl = async () => response({
      usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 34 },
      candidates: [{ content: { parts: [{ text: '回答' }] }, groundingMetadata: { groundingChunks: [] } }],
    });
    const code = await runCli(['質問', '--provider', 'gemini'], {
      geminiApiKey: 'test', fetchImpl, usageFile,
      stdout: outputSink().stream, stderr: outputSink().stream,
    });
    assert.equal(code, 0);
    const rows = fs.readFileSync(usageFile, 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(rows.length, 1);
    assert.deepEqual({ provider: rows[0].provider, in: rows[0].in, out: rows[0].out, grounded: rows[0].grounded }, { provider: 'gemini', in: 12, out: 34, grounded: true });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('Groq 成功時に usage を台帳へ追記する', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-search-groq-ledger-'));
  try {
    const usageFile = path.join(temp, 'executor-usage.jsonl');
    const code = await runCli(['質問', '--provider', 'groq'], {
      groqApiKey: 'test', usageFile,
      fetchImpl: async () => response({ choices: [{ message: { content: '回答' } }], usage: { prompt_tokens: 21, completion_tokens: 43 } }),
      stdout: outputSink().stream, stderr: outputSink().stream,
    });
    assert.equal(code, 0);
    const row = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
    assert.deepEqual({ provider: row.provider, in: row.in, out: row.out }, { provider: 'groq', in: 21, out: 43 });
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('台帳追記が失敗しても検索結果を返す', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-search-ledger-error-'));
  try {
    const err = outputSink();
    const code = await runCli(['質問', '--provider', 'gemini'], {
      geminiApiKey: 'test', usageFile: temp,
      fetchImpl: async () => response({ candidates: [{ content: { parts: [{ text: '検索結果' }] } }] }),
      stdout: outputSink().stream, stderr: err.stream,
    });
    assert.equal(code, 0);
    assert.match(err.read(), /^使用量台帳への追記失敗: .+\n$/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
