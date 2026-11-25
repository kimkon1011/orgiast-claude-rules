import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCli } from './refresh-token.mjs';

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

test('残り日数がしきい値超なら API を呼ばずに exit 0 で終了する', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-ref-skip-'));

  try {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'INSTAGRAM_ACCESS_TOKEN=current_token\n');

    const metaPath = `${envPath}.meta.json`;
    const now = Date.now();
    const expiresAt = new Date(now + 30 * 24 * 3600 * 1000).toISOString(); // 残り30日
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ expiresAt, refreshedAt: new Date(now).toISOString(), consecutiveFailures: 0 })
    );

    let apiCalled = false;
    const mockFetch = async () => {
      apiCalled = true;
      return { ok: true, status: 200, async json() { return {}; } };
    };

    const code = await runCli(['--env', envPath, '--threshold-days', '10'], {
      stdout,
      stderr,
      fetchImpl: mockFetch,
      nowMs: now,
    });

    assert.equal(code, 0);
    assert.equal(apiCalled, false);
    assert.match(stdout.output, /更新不要（残\d+日）/);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('しきい値以下で更新し、.env の該当行だけ差し替えて他キーとコメントを保持する', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-ref-ok-'));

  try {
    const envPath = path.join(tempDir, '.env');
    const initialContent = `# カフェと宿の設定\nINSTAGRAM_USERNAME=lahaina_ushimado\nINSTAGRAM_ACCESS_TOKEN=old_token_xyz\nOTHER_KEY=keep_me\n`;
    fs.writeFileSync(envPath, initialContent);

    const metaPath = `${envPath}.meta.json`;
    const now = Date.now();
    const expiresAt = new Date(now + 5 * 24 * 3600 * 1000).toISOString(); // 残り5日 <= 10日
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ expiresAt, refreshedAt: new Date(now).toISOString(), consecutiveFailures: 0 })
    );

    const mockFetch = async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          access_token: 'new_refreshed_token_abc',
          token_type: 'bearer',
          expires_in: 5184000, // 60日
        };
      },
    });

    const code = await runCli(['--env', envPath, '--threshold-days', '10'], {
      stdout,
      stderr,
      fetchImpl: mockFetch,
      nowMs: now,
    });

    assert.equal(code, 0);
    assert.match(stdout.output, /更新成功（残60日）/);

    const updatedEnv = fs.readFileSync(envPath, 'utf8');
    assert.match(updatedEnv, /# カフェと宿の設定/);
    assert.match(updatedEnv, /INSTAGRAM_USERNAME=lahaina_ushimado/);
    assert.match(updatedEnv, /INSTAGRAM_ACCESS_TOKEN=new_refreshed_token_abc/);
    assert.match(updatedEnv, /OTHER_KEY=keep_me/);
    assert.ok(!updatedEnv.includes('old_token_xyz'));

    const updatedMeta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(updatedMeta.consecutiveFailures, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('24時間未満エラーで assumed:true を書いて exit 0 で終了する', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-ref-24h-'));

  try {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'INSTAGRAM_ACCESS_TOKEN=recent_token\n');

    const mockFetch = async () => ({
      ok: false,
      status: 400,
      async json() {
        return {
          error: {
            message: 'Cannot refresh access token before 24 hours',
            code: 190,
          },
        };
      },
    });

    const code = await runCli(['--env', envPath], {
      stdout,
      stderr,
      fetchImpl: mockFetch,
    });

    assert.equal(code, 0);
    assert.match(stdout.output, /発行から24時間未満のため今回は更新しない/);

    const metaPath = `${envPath}.meta.json`;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.assumed, true);
    assert.equal(meta.consecutiveFailures, 0);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('3回連続失敗でメタの consecutiveFailures が 3 になり exit 2 を返す', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-ref-fail3-'));

  try {
    const envPath = path.join(tempDir, '.env');
    fs.writeFileSync(envPath, 'INSTAGRAM_ACCESS_TOKEN=bad_token\n');

    const metaPath = `${envPath}.meta.json`;
    fs.writeFileSync(
      metaPath,
      JSON.stringify({ expiresAt: new Date(Date.now() - 1000).toISOString(), consecutiveFailures: 2 })
    );

    const mockFetch = async () => ({
      ok: false,
      status: 400,
      async json() {
        return {
          error: {
            message: 'Invalid OAuth access token',
            code: 190,
          },
        };
      },
    });

    const code = await runCli(['--env', envPath], {
      stdout,
      stderr,
      fetchImpl: mockFetch,
    });

    assert.equal(code, 2);
    assert.match(stderr.output, /3回連続で更新に失敗/);
    assert.match(stderr.output, /NOTIFY:/);

    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    assert.equal(meta.consecutiveFailures, 3);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('トークン未登録なら .env を作らず exit 1 で終了する', async () => {
  const stdout = createMockStream();
  const stderr = createMockStream();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ig-ref-notoken-'));

  try {
    const nonExistentEnv = path.join(tempDir, 'missing.env');

    const code = await runCli(['--env', nonExistentEnv], {
      stdout,
      stderr,
    });

    assert.equal(code, 1);
    assert.match(stderr.output, /トークン未登録/);
    assert.equal(fs.existsSync(nonExistentEnv), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
