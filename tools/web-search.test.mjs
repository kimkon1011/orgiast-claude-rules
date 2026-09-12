import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { extractExecutedToolUrls, loadOpenRouterApiKey, parseArgs, requestGskCrawl, requestGskSearch, runCli, search } from './web-search.mjs';

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

function fakeSpawnWith(body, code = 0, capture = () => {}) {
  return (cmd, args, options) => {
    capture(cmd, args, options);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    queueMicrotask(() => {
      if (body.stdout) child.stdout.write(body.stdout);
      if (body.stderr) child.stderr.write(body.stderr);
      child.stdout.end();
      child.stderr.end();
      child.emit('close', code);
    });
    return child;
  };
}

const gskSuccess = JSON.stringify({
  version: 1, status: 'ok', message: 'success',
  data: { organic_results: [{ title: '結果', link: 'https://example.com/result', snippet: '説明' }] },
});

test('extractExecutedToolUrls は末尾の全角 。 を除去して重複を消す', () => {
  const urls = extractExecutedToolUrls([
    { snippet: '【orgiast.jp】(https://www.orgiast.jp/company)。' },
    { url: 'https://www.orgiast.jp/company' },
  ]).map(({ url }) => url);
  assert.deepEqual(urls, ['https://www.orgiast.jp/company']);
});

for (const punctuation of ['）', '、', '，']) {
  test(`extractExecutedToolUrls は末尾の全角 ${punctuation} を除去する`, () => {
    const urls = extractExecutedToolUrls([
      { snippet: `出典 https://www.orgiast.jp/company${punctuation}` },
    ]).map(({ url }) => url);
    assert.deepEqual(urls, ['https://www.orgiast.jp/company']);
  });
}

test('extractExecutedToolUrls は Markdown リンクから ](https://… を飲み込まない', () => {
  const urls = extractExecutedToolUrls([
    { snippet: '出典 [https://www.orgiast.jp/company](https://www.orgiast.jp/company) を参照' },
    { url: 'https://www.orgiast.jp/company' },
  ]).map(({ url }) => url);
  assert.deepEqual(urls, ['https://www.orgiast.jp/company']);
});

test('extractExecutedToolUrls は末尾の半角約物を従来どおり除去する', () => {
  const urls = extractExecutedToolUrls([
    { snippet: 'see https://example.com/a).' },
  ]).map(({ url }) => url);
  assert.deepEqual(urls, ['https://example.com/a']);
});

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
  // gskApiKey を空にして auto 連鎖の受け皿(gsk)から実 CLI を叩かせない（有料レーンの実呼び出し防止）。
  const code = await runCli(['質問'], {
    geminiApiKey: 'gemini-test', groqApiKey: 'groq-test', openrouterApiKey: '', gskApiKey: '', fetchImpl,
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

test('--provider openrouter で本文と annotations の URL を JSON で返す', async () => {
  const out = outputSink();
  let request;
  const code = await runCli(['質問', '--provider', 'openrouter', '--json'], {
    openrouterApiKey: 'test',
    fetchImpl: async (url, init) => {
      request = { url, init };
      return response({ choices: [{ message: { content: ' OpenRouter回答 ', annotations: [{ url_citation: { url: 'https://example.com/source' } }] } }] });
    },
    stdout: out.stream, stderr: outputSink().stream,
  });
  assert.equal(code, 0);
  assert.match(request.url, /openrouter\.ai/);
  assert.equal(request.init.headers['HTTP-Referer'], 'https://orgiast.jp');
  assert.deepEqual(JSON.parse(out.read()), {
    query: '質問', provider: 'openrouter', model: 'openai/gpt-oss-120b:online', answer: 'OpenRouter回答',
    urls: ['https://example.com/source'], elapsedMs: JSON.parse(out.read()).elapsedMs,
  });
});

test('auto は Gemini と Groq の 429 後に OpenRouter へフォールバックする', async () => {
  const calls = [];
  const result = await search('質問', {
    geminiApiKey: 'gemini-test', groqApiKey: 'groq-test', openrouterApiKey: 'openrouter-test',
    fetchImpl: async (url) => {
      calls.push(url);
      if (!url.includes('openrouter.ai')) return response({ error: 'rate limit' }, 429);
      return response({ choices: [{ message: { content: '回答' } }] });
    },
    appendUsage() {},
  });
  assert.equal(calls.length, 3);
  assert.equal(result.provider, 'openrouter');
  assert.equal(result.failures.length, 2);
  assert.match(result.failures[0], /gemini: Gemini API HTTP 429/);
  assert.match(result.failures[1], /groq: Groq API HTTP 429/);
});

test('OpenRouter キーが無い auto は APIキーなしとしてスキップしクラッシュしない', async () => {
  await assert.rejects(search('質問', {
    env: {}, homeDir: '/存在しないテスト用パス', geminiApiKey: 'gemini-test', groqApiKey: 'groq-test',
    fetchImpl: async () => response({ error: 'down' }, 500), appendUsage() {},
  }), (error) => {
    assert.equal(error.failures.length, 4);
    assert.equal(error.failures[2], 'openrouter: APIキーなし');
    assert.equal(error.failures[3], 'gsk: APIキーなし');
    return true;
  });
});

test('parseArgs は openrouter を受け付け未知の provider を拒否する', () => {
  assert.equal(parseArgs(['質問', '--provider', 'openrouter']).provider, 'openrouter');
  assert.throws(() => parseArgs(['質問', '--provider', 'unknown']), /auto\|gemini\|groq\|openrouter/);
});

test('parseArgs は gsk を受け付け bogus provider を拒否する', () => {
  assert.equal(parseArgs(['q', '--provider', 'gsk']).provider, 'gsk');
  assert.throws(() => parseArgs(['q', '--provider', 'bogus']), /auto\|gemini\|groq\|openrouter\|gsk/);
});

test('search は fake spawn で gsk 検索結果を返す', async () => {
  const result = await search('テスト', {
    provider: 'gsk', gskApiKey: 'k', appendUsage() {},
    spawnImpl: fakeSpawnWith({ stdout: gskSuccess }),
  });
  assert.equal(result.provider, 'gsk');
  assert.equal(result.answer, '結果 — 説明');
  assert.deepEqual(result.urls, [{ url: 'https://example.com/result', title: '結果' }]);
});

test('requestGskSearch はクエリを argv に載せず --args-file で渡す', async () => {
  const query = 'シェルに出してはいけない; echo injected';
  let invocation;
  await requestGskSearch({
    query, apiKey: 'k',
    spawnImpl: fakeSpawnWith({ stdout: gskSuccess }, 0, (cmd, args, options) => {
      invocation = { cmd, args, options, argsFile: JSON.parse(fs.readFileSync(args[2], 'utf8')) };
    }),
  });
  assert.ok(!invocation.args.includes(query));
  assert.deepEqual(invocation.args.slice(0, 2), ['search', '--args-file']);
  assert.equal(invocation.argsFile.q, query);
  assert.equal(invocation.options.windowsHide, true);
});

test('requestGskSearch は organic_results が空なら空の answer と urls を返す', async () => {
  const result = await requestGskSearch({
    query: 'q', apiKey: 'k',
    spawnImpl: fakeSpawnWith({ stdout: JSON.stringify({ status: 'ok', data: { organic_results: [] } }) }),
  });
  assert.equal(result.answer, '');
  assert.deepEqual(result.urls, []);
});

test('requestGskSearch は終了コード非 0 で reject する', async () => {
  await assert.rejects(requestGskSearch({
    query: 'q', apiKey: 'k', spawnImpl: fakeSpawnWith({ stderr: 'CLI failure detail' }, 7),
  }), /exit 7: CLI failure detail/);
});

test('requestGskCrawl は http/https 以外の URL を拒否する', async () => {
  await assert.rejects(requestGskCrawl({
    url: 'file:///etc/passwd', apiKey: 'k', spawnImpl: fakeSpawnWith({ stdout: gskSuccess }),
  }), /http\/https/);
});

test('requestGskCrawl は URL を正規化しシェル経由のときだけ引用する', async () => {
  let invoked;
  await requestGskCrawl({
    url: 'https://example.com/a b?x=1&y=2', apiKey: 'k',
    spawnImpl: fakeSpawnWith({ stdout: '{"status":"ok","data":{"content":"本文"}}' }, 0, (_cmd, args) => { invoked = args; }),
  });
  const normalized = 'https://example.com/a%20b?x=1&y=2';
  assert.equal(invoked[0], 'crawl');
  assert.equal(invoked[1], process.platform === 'win32' ? `"${normalized}"` : normalized);
});

test('loadOpenRouterApiKey は env を優先し openrouter.env へフォールバックする', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'web-search-openrouter-key-'));
  try {
    fs.mkdirSync(path.join(temp, '.claude'));
    fs.writeFileSync(path.join(temp, '.claude', 'openrouter.env'), 'OPENROUTER_API_KEY=file-key\n');
    assert.equal(loadOpenRouterApiKey({ env: { OPENROUTER_API_KEY: 'env-key' }, homeDir: temp }), 'env-key');
    assert.equal(loadOpenRouterApiKey({ env: {}, homeDir: temp }), 'file-key');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
