import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRawUrl,
  validateMediaFile,
  checkPublicMediaUrl,
  runCli,
} from './publish-media.mjs';

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

test('buildRawUrl はリポジトリ・ブランチ・パスから正しい raw.githubusercontent.com URLを生成する', () => {
  const url = buildRawUrl({
    repo: 'kimkon1011/orgiast-claude-rules',
    branch: 'main',
    path: 'media/lahaina/photo.jpg',
  });
  assert.equal(
    url,
    'https://raw.githubusercontent.com/kimkon1011/orgiast-claude-rules/main/media/lahaina/photo.jpg'
  );
});

test('validateMediaFile は許可された拡張子と上限サイズを検証する', () => {
  assert.equal(validateMediaFile({ filePath: 'pic.jpg', sizeBytes: 1024 }).valid, true);
  assert.equal(validateMediaFile({ filePath: 'pic.jpeg', sizeBytes: 1024 }).valid, true);
  assert.equal(validateMediaFile({ filePath: 'pic.png', sizeBytes: 1024 }).valid, true);
  assert.equal(validateMediaFile({ filePath: 'clip.mp4', sizeBytes: 1024 }).valid, true);

  // 不正な拡張子
  const badExt = validateMediaFile({ filePath: 'doc.pdf', sizeBytes: 1024 });
  assert.equal(badExt.valid, false);
  assert.match(badExt.reason, /サポートされていない拡張子/);

  // 8MB 超過
  const oversized = validateMediaFile({
    filePath: 'large.jpg',
    sizeBytes: 9 * 1024 * 1024,
  });
  assert.equal(oversized.valid, false);
  assert.match(oversized.reason, /8MBを超えています/);
});

test('checkPublicMediaUrl は content-type: text/html を拒否する', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
  });

  const res = await checkPublicMediaUrl('https://example.com/page', {
    fetchImpl: mockFetch,
  });

  assert.equal(res.ok, false);
  assert.equal(res.contentType, 'text/html; charset=utf-8');
});

test('checkPublicMediaUrl は content-type: image/jpeg かつ HTTP 200 を成功とする', async () => {
  const mockFetch = async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'image/jpeg' }),
  });

  const res = await checkPublicMediaUrl('https://example.com/pic.jpg', {
    fetchImpl: mockFetch,
  });

  assert.equal(res.ok, true);
  assert.equal(res.status, 200);
});

test('publish-media.mjs CLI はトークン未設定で exit 1 を返し、APIを呼ばない', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  let apiCalled = false;

  const mockFetch = async () => {
    apiCalled = true;
    return { ok: true, status: 200 };
  };

  const code = await runCli(['--file', 'test.jpg'], {
    stdout,
    stderr,
    fetchImpl: mockFetch,
    githubToken: null,
  });

  assert.equal(code, 1);
  assert.equal(apiCalled, false);
  assert.match(stderr.output, /GitHub トークン未設定/);
});

test('publish-media.mjs CLI は正常系でファイルをアップロードし読み戻し検証する', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-pub-ok-'));

  try {
    const filePath = path.join(tempDir, 'photo.jpg');
    fs.writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0])); // JPEG magic bytes

    const calls = [];
    const mockFetch = async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('api.github.com')) {
        return {
          ok: true,
          status: 201,
          async json() {
            return { content: { path: 'media/lahaina/photo.jpg' } };
          },
        };
      }
      // raw.githubusercontent.com verification
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'image/jpeg' }),
      };
    };

    const code = await runCli(['--file', filePath, '--json'], {
      stdout,
      stderr,
      fetchImpl: mockFetch,
      githubToken: 'ghp_mock_token_123',
    });

    assert.equal(code, 0);
    const parsed = JSON.parse(stdout.output);
    assert.equal(parsed.ok, true);
    assert.match(parsed.rawUrl, /photo\.jpg/);
    assert.equal(calls.length, 2); // 1 upload + 1 read-back check
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
