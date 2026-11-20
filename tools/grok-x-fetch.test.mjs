import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs, fetchXPost, runCli } from './grok-x-fetch.mjs';

test('parseArgs correctly parses arguments', () => {
  const cases = [
    {
      argv: ['--url', 'https://x.com/user/status/12345'],
      expected: { url: 'https://x.com/user/status/12345', model: 'grok-4.6' }
    },
    {
      argv: ['-u', 'https://x.com/user/status/12345', '--model', 'grok-3'],
      expected: { url: 'https://x.com/user/status/12345', model: 'grok-3' }
    },
    {
      argv: ['https://x.com/user/status/54321', '-m', 'grok-beta'],
      expected: { url: 'https://x.com/user/status/54321', model: 'grok-beta' }
    }
  ];

  for (const c of cases) {
    assert.deepEqual(parseArgs(c.argv), c.expected);
  }
});

const syndicationUrl = 'https://cdn.syndication.twimg.com/tweet-result?id=12345&token=a';

test('runCli uses syndication without a key and renders post details', async () => {
  let stdout = '';
  let stderr = '';
  const code = await runCli(['https://twitter.com/user/status/12345?s=20'], {
    stdout: { write: (text) => { stdout += text; } },
    stderr: { write: (text) => { stderr += text; } },
    loadKeyFn: () => '',
    fetchFn: async (url, options) => {
      assert.equal(url, syndicationUrl);
      assert.equal(options.headers, undefined);
      return Response.json({
        user: { screen_name: 'user' },
        created_at: '2026-11-20T00:00:00Z',
        text: 'Post about Garry Tan',
        note_tweet: { id: 'note' },
        mediaDetails: [
          { type: 'photo', media_url_https: 'https://pbs.twimg.com/picture.jpg' },
          { type: 'video', video_info: { variants: [
            { bitrate: 100, url: 'https://video.twimg.com/low.mp4' },
            { bitrate: 200, url: 'https://video.twimg.com/high.mp4' },
          ] } },
        ],
        quoted_tweet: {
          user: { screen_name: 'quoted' },
          text: 'short quote',
          note_tweet: { text: 'The full agent loop quote' },
          article: { title: 'Agent loops', preview_text: 'Article preview' },
        },
      });
    },
  });
  assert.equal(code, 0, stderr);
  assert.match(stdout, /^取得経路: syndication（Grok 失敗: XAI_API_KEY 未設定）\n\n--- 投稿本文 ---/);
  assert.match(stdout, /投稿者: @user\n日時: 2026-11-20T00:00:00Z\nPost about Garry Tan\n（本文は途中まで）/);
  assert.match(stdout, /画像: https:\/\/pbs\.twimg\.com\/picture\.jpg\n動画: https:\/\/video\.twimg\.com\/high\.mp4/);
  assert.match(stdout, /--- 引用ポスト ---\n投稿者: @quoted\nThe full agent loop quote\n記事: Agent loops\nArticle preview/);
  assert.match(stdout, /出典: https:\/\/twitter\.com\/user\/status\/12345\?s=20/);
  assert.equal(stderr, '');
});

for (const status of [402, 403, 429, 500, 503, 'ネットワークエラー']) {
  test(`fetchXPost falls back after ${status}`, async () => {
    const calls = [];
    const result = await fetchXPost({ url: 'https://x.com/i/status/12345', model: 'grok-4.6' }, {
      loadKeyFn: () => 'mock-key',
      fetchFn: async (url) => {
        calls.push(url);
        if (url === syndicationUrl) return Response.json({ text: 'Post' });
        if (typeof status === 'string') throw new TypeError('fetch failed');
        return new Response('Grok unavailable', { status });
      },
    });
    assert.deepEqual(calls, ['https://api.x.ai/v1/responses', syndicationUrl]);
    assert.equal(result.route, `取得経路: syndication（Grok 失敗: ${status}）`);
    assert.equal(result.text, 'Post');
  });
}

test('fetchXPost records credit exhaustion in existing lane health and usage files', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-x-fetch-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'lane-health.json');
  const otherLane = { alive: true, reason: 'probe_ok' };
  fs.writeFileSync(file, JSON.stringify({
    lanes: { codex: otherLane, grok: { alive: true, until: 123, lastProbeOkAt: '2026-11-20T00:00:00Z' } },
  }));
  await fetchXPost({ url: 'https://x.com/user/status/12345', model: 'grok-4.6' }, {
    loadKeyFn: () => 'mock-key',
    getClaudeDirFn: () => dir,
    fetchFn: async (url) => url === syndicationUrl ? Response.json({ text: 'Post' })
      : new Response('used all available credits or reached its monthly spending limit', { status: 403 }),
  });
  const { lanes } = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(lanes.codex, otherLane);
  assert.equal(lanes.grok.alive, false);
  assert.equal(lanes.grok.reason, 'billing');
  assert.equal(lanes.grok.until, undefined);
  assert.equal(lanes.grok.lastProbeOkAt, '2026-11-20T00:00:00Z');
  const usage = JSON.parse(fs.readFileSync(path.join(dir, 'executor-usage.jsonl'), 'utf8'));
  assert.equal(usage.provider, 'grok');
  assert.equal(usage.status, 'error');
  assert.equal(usage.httpStatus, 403);
});

test('fetchXPost rejects non-X status URLs for syndication', async () => {
  await assert.rejects(fetchXPost({ url: 'https://x.com.example/user/status/12345' }, {
    loadKeyFn: () => '',
    fetchFn: () => assert.fail('unexpected lookup'),
  }), /投稿IDを取得できません/);
});
test('fetchXPost throws error if URL is not specified', async () => {
  const options = { url: '', model: 'grok-4.6' };
  const dependencies = {
    loadKeyFn: () => 'fake_key',
  };

  await assert.rejects(
    fetchXPost(options, dependencies),
    /URLを指定してください/
  );
});

test('fetchXPost makes correct API call and returns output & logs usage', async () => {
  const options = { url: 'https://x.com/user/status/12345', model: 'grok-4.6' };

  let calledUrl = '';
  let calledOptions = {};
  const mockFetch = async (url, opts) => {
    calledUrl = url;
    calledOptions = opts;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        output: [
          {
            type: 'message',
            content: [
              { type: 'output_text', text: 'Hello, this is the post text.' },
              { type: 'source', url: 'https://x.com/user/status/12345' }
            ]
          }
        ],
        usage: {
          input_tokens: 150,
          output_tokens: 50
        }
      })
    };
  };

  let loggedContent = '';
  const mockFs = {
    appendFileSync: (file, content) => {
      loggedContent += content;
    }
  };

  const dependencies = {
    fetchFn: mockFetch,
    fsFn: mockFs,
    getClaudeDirFn: () => '/fake/dir',
    loadKeyFn: () => 'valid_key_123'
  };

  const result = await fetchXPost(options, dependencies);

  // Assert return result
  assert.equal(result.text, 'Hello, this is the post text.');
  assert.deepEqual(result.citations, ['https://x.com/user/status/12345']);
  assert.deepEqual(result.usage, { input_tokens: 150, output_tokens: 50 });

  // Assert API call parameters
  assert.equal(calledUrl, 'https://api.x.ai/v1/responses');
  assert.equal(calledOptions.method, 'POST');
  assert.equal(calledOptions.headers['Authorization'], 'Bearer valid_key_123');
  assert.equal(calledOptions.headers['Content-Type'], 'application/json');

  const parsedBody = JSON.parse(calledOptions.body);
  assert.equal(parsedBody.model, 'grok-4.6');
  assert.deepEqual(parsedBody.tools, [{ type: 'x_search' }]);
  assert.equal(parsedBody.input[0].content, 'Fetch the X (Twitter) post at this URL and reply with only its exact, complete original text content, nothing else: https://x.com/user/status/12345');

  // Assert usage was logged into executor-usage.jsonl
  const parsedLog = JSON.parse(loggedContent.trim());
  assert.equal(parsedLog.provider, 'grok');
  assert.equal(parsedLog.model, 'grok-4.6');
  assert.equal(parsedLog.in, 150);
  assert.equal(parsedLog.out, 50);
  assert.equal(parsedLog.x_fetch, true);
});

test('runCli writes help if no URL specified', async () => {
  let stderrOutput = '';
  const mockStderr = {
    write: (str) => { stderrOutput += str; }
  };
  const mockStdout = {
    write: () => {}
  };

  const dependencies = {
    stderr: mockStderr,
    stdout: mockStdout,
  };

  const code = await runCli([], dependencies);
  assert.equal(code, 2);
  assert.match(stderrOutput, /使い方: node tools\/grok-x-fetch.mjs/);
});

test('runCli reports error on API failures', async () => {
  let stderrOutput = '';
  const mockStderr = {
    write: (str) => { stderrOutput += str; }
  };
  let stdoutOutput = '';
  const mockStdout = {
    write: (str) => { stdoutOutput += str; }
  };

  const dependencies = {
    stderr: mockStderr,
    stdout: mockStdout,
    loadKeyFn: () => 'some_key',
    fetchFn: async () => ({
      ok: false,
      status: 400,
      text: async () => 'Forbidden request'
    })
  };

  const code = await runCli(['--url', 'https://x.com/user/status/12345'], dependencies);
  assert.equal(code, 1);
  assert.match(stderrOutput, /エラー: Grok API呼び出し失敗/);
});

test('fetchXPost reports a failed fallback and retains the Grok status', async () => {
  await assert.rejects(fetchXPost({ url: 'https://x.com/user/status/12345' }, {
    loadKeyFn: () => 'mock-key',
    fetchFn: async (url) => url === syndicationUrl
      ? Response.json({}) : new Response('Forbidden', { status: 403 }),
  }), /syndication 取得失敗（Grok 失敗: 403）: 投稿データなし/);
});
