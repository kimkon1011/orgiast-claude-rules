import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './post.mjs';
import {
  createMediaContainer,
  waitForContainer,
  publishContainer,
  postToInstagram,
  IgApiError,
} from './ig-api.mjs';

function createMockStream() {
  let output = '';
  return {
    write(chunk) {
      output += chunk;
    },
    get output() {
      return output;
    },
  };
}

test('createMediaContainer は IMAGE 時に image_url を渡し、containerId を返す', async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { id: 'container_123' };
      },
    };
  };

  const res = await createMediaContainer({
    igUserId: 'user_999',
    mediaType: 'IMAGE',
    url: 'https://example.com/photo.jpg',
    caption: 'テストキャプション',
    accessToken: 'test_token',
    fetchImpl: mockFetch,
  });

  assert.equal(res.containerId, 'container_123');
  assert.equal(calls.length, 1);
  const bodyParams = new URLSearchParams(calls[0].options.body);
  assert.equal(bodyParams.get('image_url'), 'https://example.com/photo.jpg');
  assert.equal(bodyParams.get('caption'), 'テストキャプション');
  assert.equal(bodyParams.get('access_token'), 'test_token');
  assert.equal(bodyParams.get('is_carousel_item'), null);
});

test('waitForContainer は IN_PROGRESS から FINISHED までポーリングする', async () => {
  let pollCount = 0;
  const mockFetch = async (url) => {
    pollCount += 1;
    return {
      ok: true,
      status: 200,
      async json() {
        if (pollCount === 1) {
          return { id: 'cnt_1', status_code: 'IN_PROGRESS', status: 'Processing' };
        }
        return { id: 'cnt_1', status_code: 'FINISHED', status: 'Ready' };
      },
    };
  };

  const status = await waitForContainer({
    containerId: 'cnt_1',
    accessToken: 'tok',
    fetchImpl: mockFetch,
    sleep: async () => {},
  });

  assert.equal(status.statusCode, 'FINISHED');
  assert.equal(pollCount, 2);
});

test('waitForContainer は ERROR または EXPIRED で IgApiError を投げる', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { id: 'cnt_err', status_code: 'ERROR', status: 'Failed' };
    },
  });

  await assert.rejects(
    waitForContainer({
      containerId: 'cnt_err',
      accessToken: 'tok',
      fetchImpl: mockFetch,
      sleep: async () => {},
    }),
    (err) => {
      assert.ok(err instanceof IgApiError);
      assert.match(err.message, /Container cnt_err failed with status: ERROR/);
      return true;
    }
  );
});

test('publishContainer は creation_id を送信して mediaId を返す', async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      status: 200,
      async json() {
        return { id: 'media_456' };
      },
    };
  };

  const res = await publishContainer({
    igUserId: 'user_999',
    creationId: 'container_123',
    accessToken: 'tok',
    fetchImpl: mockFetch,
  });

  assert.equal(res.mediaId, 'media_456');
  const bodyParams = new URLSearchParams(calls[0].options.body);
  assert.equal(bodyParams.get('creation_id'), 'container_123');
});

test('post.mjs --dry-run はトークンが無くてもパラメータJSONを出力して成功する', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-post-test-'));

  try {
    const code = await runCli(
      [
        '--image',
        'https://example.com/test.jpg',
        '--caption',
        'テスト',
        '--dry-run',
        '--env',
        path.join(tempDir, 'nonexistent.env'),
      ],
      { stdout, stderr }
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.output);
    assert.equal(parsed.image_url, 'https://example.com/test.jpg');
    assert.equal(parsed.media_type, 'IMAGE');
    assert.equal(parsed.caption_length, 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('post.mjs は http:// の非SSL URLを exit 2 で拒否する', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();

  const code = await runCli(['--image', 'http://insecure.example.com/pic.jpg'], {
    stdout,
    stderr,
  });

  assert.equal(code, 2);
  assert.match(stderr.output, /https:\/\/ で始まる公開URL/);
});

test('post.mjs は過去24時間の投稿数が上限以上の場合は投稿せず exit 3 で終了する', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-post-limit-'));

  try {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'INSTAGRAM_ACCESS_TOKEN=test_tok\nINSTAGRAM_USER_ID=user_1\n');

    const logPath = path.join(tempDir, 'post-log.jsonl');
    const now = Date.now();
    const existingLogs = [
      JSON.stringify({ at: new Date(now - 1000).toISOString(), mediaId: 'm1' }),
      JSON.stringify({ at: new Date(now - 2000).toISOString(), mediaId: 'm2' }),
    ].join('\n');
    fs.writeFileSync(logPath, `${existingLogs}\n`);

    const code = await runCli(
      ['--image', 'https://example.com/new.jpg', '--env', envPath, '--max-per-day', '2'],
      { stdout, stderr, nowMs: now }
    );

    assert.equal(code, 3);
    assert.match(stderr.output, /過去24時間の投稿数が上限 \(2件\) に達しています/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('post.mjs は正常系で投稿し post-log.jsonl に記録する', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-post-ok-'));

  try {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'INSTAGRAM_ACCESS_TOKEN=tok_abc\nINSTAGRAM_USER_ID=usr_123\n');

    const mockFetch = async (url) => {
      const urlStr = String(url);
      if (urlStr.includes('/media_publish')) {
        return { ok: true, status: 200, async json() { return { id: 'media_pub_1' }; } };
      }
      if (urlStr.includes('media_pub_1')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              id: 'media_pub_1',
              permalink: 'https://www.instagram.com/p/DBTEST123/',
              media_type: 'IMAGE',
            };
          },
        };
      }
      if (urlStr.includes('/media')) {
        return { ok: true, status: 200, async json() { return { id: 'cnt_created_1' }; } };
      }
      return { ok: true, status: 200, async json() { return {}; } };
    };

    const code = await runCli(
      ['--image', 'https://example.com/ok.jpg', '--caption', '本文', '--env', envPath, '--json'],
      { stdout, stderr, fetchImpl: mockFetch }
    );

    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.output);
    assert.equal(parsed.mediaId, 'media_pub_1');
    assert.equal(parsed.permalink, 'https://www.instagram.com/p/DBTEST123/');

    const logPath = path.join(tempDir, 'post-log.jsonl');
    const logContent = fs.readFileSync(logPath, 'utf8');
    assert.match(logContent, /media_pub_1/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('post.mjs は --timeout を fetch の AbortSignal に反映する', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-post-timeout-'));

  try {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'INSTAGRAM_ACCESS_TOKEN=tok_timeout\nINSTAGRAM_USER_ID=usr_1\n');

    const seenSignals = [];
    const mockFetch = async (url, init = {}) => {
      seenSignals.push(init.signal);
      const urlStr = String(url);
      if (urlStr.includes('/media_publish')) {
        return { ok: true, status: 200, async json() { return { id: 'm_timeout' }; } };
      }
      if (urlStr.includes('m_timeout')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { id: 'm_timeout', permalink: 'https://www.instagram.com/p/T1/' };
          },
        };
      }
      return { ok: true, status: 200, async json() { return { id: 'cnt_t' }; } };
    };

    const code = await runCli(
      ['--image', 'https://example.com/t.jpg', '--env', envPath, '--timeout', '7'],
      { stdout, stderr, fetchImpl: mockFetch }
    );

    assert.equal(code, 0);
    assert.ok(seenSignals.length >= 1, 'fetch が呼ばれていること');
    for (const signal of seenSignals) {
      assert.ok(signal instanceof AbortSignal, 'fetch に AbortSignal が渡ること');
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('post.mjs は --timeout 経過で fetch を中断し exit 1 で終了する', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-post-timeout-fire-'));

  try {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'INSTAGRAM_ACCESS_TOKEN=tok_timeout\nINSTAGRAM_USER_ID=usr_1\n');

    // 応答を返さず、AbortSignal が発火したら中断される fetch を模擬する
    const mockFetch = (url, init = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          const error = new Error('The operation was aborted due to timeout');
          error.name = 'TimeoutError';
          reject(error);
        });
      });

    const code = await runCli(
      ['--image', 'https://example.com/t.jpg', '--env', envPath, '--timeout', '1'],
      { stdout, stderr, fetchImpl: mockFetch }
    );

    assert.equal(code, 1);
    assert.match(stderr.output, /1秒のタイムアウトを超えました/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
