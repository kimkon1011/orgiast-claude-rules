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

test('fetchXPost throws error if XAI_API_KEY is not configured', async () => {
  const options = { url: 'https://x.com/user/status/12345', model: 'grok-4.6' };
  const dependencies = {
    loadKeyFn: () => '',
  };

  await assert.rejects(
    fetchXPost(options, dependencies),
    /XAI_API_KEY 未設定/
  );
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
      status: 403,
      text: async () => 'Forbidden request'
    })
  };

  const code = await runCli(['--url', 'https://x.com/user/status/12345'], dependencies);
  assert.equal(code, 1);
  assert.match(stderrOutput, /エラー: Grok API呼び出し失敗/);
});
