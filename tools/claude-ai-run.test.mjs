import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  AUTH_ENV_KEYS,
  buildChildArgs,
  buildConnectorEnv,
  buildPrompt,
  parseArgs,
  runConnectorPrompt,
} from './claude-ai-run.mjs';

const tool = fileURLToPath(new URL('./claude-ai-run.mjs', import.meta.url));

function createFakeChild({ exitCode = 0, delayMs = 5, emitStdout = '', emitStderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = (signal) => {
    child.killed = true;
    setImmediate(() => {
      child.emit('close', null);
    });
    return true;
  };

  setImmediate(() => {
    if (emitStdout) child.stdout.write(emitStdout);
    if (emitStderr) child.stderr.write(emitStderr);
    setTimeout(() => {
      if (!child.killed) {
        child.emit('close', exitCode);
      }
    }, delayMs);
  });

  return child;
}

test('buildConnectorEnv: 認証系キーが除去され、無関係な env は残り、親は変更されない', () => {
  const parent = Object.freeze({
    PATH: '/usr/bin:/bin',
    HOME: '/home/user',
    ANTHROPIC_AUTH_TOKEN: 'secret-token-123',
    ANTHROPIC_BASE_URL: 'https://api.deepseek.com/anthropic',
    ANTHROPIC_API_KEY: 'secret-key-456',
    SAFE_KEY: 'keep-me',
  });

  const { env, stripped } = buildConnectorEnv(parent);

  assert.equal(env.PATH, '/usr/bin:/bin');
  assert.equal(env.HOME, '/home/user');
  assert.equal(env.SAFE_KEY, 'keep-me');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);

  // 親オブジェクトが変更されていない
  assert.equal(parent.ANTHROPIC_AUTH_TOKEN, 'secret-token-123');
  assert.equal(parent.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(parent.ANTHROPIC_API_KEY, 'secret-key-456');

  // stripped に落としたキー名が入り、値は入らない
  assert.deepEqual(stripped.sort(), [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);
  assert.ok(!stripped.includes('secret-token-123'));
  assert.ok(!stripped.includes('https://api.deepseek.com/anthropic'));
  assert.ok(!stripped.includes('secret-key-456'));
});

test('buildConnectorEnv: 小文字キー anthropic_auth_token や混在ケースも落ちる', () => {
  const parent = {
    anthropic_auth_token: 'lower-token',
    Anthropic_Base_Url: 'mixed-base',
    ANTHROPIC_API_KEY: 'upper-key',
    OTHER_VAR: 'stay',
  };

  const { env, stripped } = buildConnectorEnv(parent);

  assert.equal(env.anthropic_auth_token, undefined);
  assert.equal(env.Anthropic_Base_Url, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, undefined);
  assert.equal(env.OTHER_VAR, 'stay');
  assert.deepEqual(stripped.sort(), [
    'ANTHROPIC_API_KEY',
    'Anthropic_Base_Url',
    'anthropic_auth_token',
  ]);
});

test('buildChildArgs: 既定の引数リストを返す', () => {
  const args = buildChildArgs();
  assert.deepEqual(args, [
    '-p',
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'text',
  ]);
});

test('buildChildArgs: --model 指定時に model オプションが挿入される', () => {
  const args = buildChildArgs({ model: 'claude-3-5-sonnet-20241022' });
  assert.deepEqual(args, [
    '-p',
    '--model',
    'claude-3-5-sonnet-20241022',
    '--permission-mode',
    'bypassPermissions',
    '--output-format',
    'text',
  ]);
});

test('buildPrompt: 先頭に [headless:claude-ai-run] が付き指示本文が含まれる', () => {
  const prompt = buildPrompt('Drive のファイルを検索する');
  assert.match(
    prompt,
    /^\[headless:claude-ai-run\] 回答は1つの最終メッセージに全文を出す。「前の回答のとおり」等の参照は禁止。/
  );
  assert.match(prompt, /Drive のファイルを検索する$/);
});

test('runConnectorPrompt: 渡された env に ANTHROPIC_AUTH_TOKEN が無く、stdin にプロンプトが流れ、終了コードを返す', async () => {
  let capturedBin = null;
  let capturedArgs = null;
  let capturedEnv = null;
  let capturedStdin = '';

  const fakeSpawn = (bin, args, opts) => {
    capturedBin = bin;
    capturedArgs = args;
    capturedEnv = opts.env;
    const child = createFakeChild({ exitCode: 0, emitStdout: '実行成功' });
    child.stdin.on('data', (chunk) => {
      capturedStdin += chunk.toString();
    });
    return child;
  };

  const res = await runConnectorPrompt({
    spawnFn: fakeSpawn,
    executable: 'C:\\tools\\claude.exe',
    args: ['-p', '--output-format', 'text'],
    prompt: 'テストプロンプト本文',
    env: {
      PATH: '/bin',
      ANTHROPIC_AUTH_TOKEN: 'secret-token-to-strip',
      ANTHROPIC_BASE_URL: 'https://example.com',
    },
  });

  assert.equal(capturedBin, 'C:\\tools\\claude.exe');
  assert.deepEqual(capturedArgs, ['-p', '--output-format', 'text']);
  assert.equal(capturedEnv.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(capturedEnv.ANTHROPIC_BASE_URL, undefined);
  assert.equal(capturedEnv.PATH, '/bin');
  assert.equal(capturedEnv.ORGIAST_HEADLESS_JOB, 'claude-ai-run');
  assert.equal(capturedStdin, 'テストプロンプト本文');
  assert.equal(res.code, 0);
  assert.equal(res.stdout, '実行成功');
  assert.equal(res.timedOut, false);
});

test('runConnectorPrompt: タイムアウトで kill され timedOut: true かつ code 124 を返す', async () => {
  let killed = false;

  const fakeSpawnTimeout = (bin, args, opts) => {
    const child = createFakeChild({ delayMs: 1000 });
    const originalKill = child.kill;
    child.kill = (sig) => {
      killed = true;
      return originalKill(sig);
    };
    return child;
  };

  const res = await runConnectorPrompt({
    spawnFn: fakeSpawnTimeout,
    executable: 'claude',
    prompt: '時間のかかる処理',
    timeoutMs: 25,
  });

  assert.equal(killed, true);
  assert.equal(res.timedOut, true);
  assert.equal(res.code, 124);
});

test('CLI --dry-run: JSON が返り strippedKeys に3キーが含まれ秘密値が出力されない', () => {
  const secretToken = 'TEST_SECRET_TOKEN_999';
  const secretBase = 'https://deepseek-secret.example.com';
  const secretKey = 'TEST_SECRET_KEY_888';

  const result = spawnSync(process.execPath, [tool, '--dry-run', '確認する'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      ANTHROPIC_AUTH_TOKEN: secretToken,
      ANTHROPIC_BASE_URL: secretBase,
      ANTHROPIC_API_KEY: secretKey,
    },
  });

  assert.equal(result.status, 0);
  const data = JSON.parse(result.stdout);
  assert.equal(data.promptVia, 'stdin');
  assert.ok(data.promptChars > 0);
  assert.equal(typeof data.connectorCredentialPresent, 'boolean');

  // strippedKeys に 3 つのキー名が含まれる
  assert.ok(data.strippedKeys.includes('ANTHROPIC_AUTH_TOKEN'));
  assert.ok(data.strippedKeys.includes('ANTHROPIC_BASE_URL'));
  assert.ok(data.strippedKeys.includes('ANTHROPIC_API_KEY'));

  // stdout に親の秘密値文字列が絶対に含まれない
  assert.equal(result.stdout.includes(secretToken), false);
  assert.equal(result.stdout.includes(secretBase), false);
  assert.equal(result.stdout.includes(secretKey), false);
});
