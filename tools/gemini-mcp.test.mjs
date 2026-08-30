import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { buildArgs, runGemini } from './gemini-mcp.mjs';

const server = fileURLToPath(new URL('./gemini-mcp.mjs', import.meta.url));

function run(messages) {
  return spawnSync(process.execPath, [server], {
    input: `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
    encoding: 'utf8',
    timeout: 10_000,
    // ツール呼び出しを追加しても実 Gemini を誤起動しない安全弁としてダミーを指定する。
    env: { ...process.env, ORGIAST_GEMINI_CMD: process.execPath },
  });
}

test('initialize と tools/list が二つの互換ツールを返し stdout は JSON だけになる', () => {
  const execution = run([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 'test-version' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  assert.equal(execution.status, 0, execution.stderr);
  const lines = execution.stdout.trim().split('\n');
  const responses = lines.map((line) => JSON.parse(line));
  assert.equal(responses[0].result.protocolVersion, 'test-version');
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), ['googleSearch', 'geminiChat']);
});

test('buildArgs は必須引数と任意モデルを組み立てる', () => {
  assert.deepEqual(buildArgs('質問', undefined), ['-p', '質問', '--skip-trust']);
  assert.deepEqual(buildArgs('質問', 'gemini-model'), ['-p', '質問', '--skip-trust', '-m', 'gemini-model']);
});

test('initialized 通知には返信しない', () => {
  const execution = run([{ jsonrpc: '2.0', method: 'notifications/initialized' }]);
  assert.equal(execution.status, 0, execution.stderr);
  assert.equal(execution.stdout, '');
});

test('タイムアウト時は収集済みの stderr をエラー本文に含める', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.kill = () => true;
  const spawnImpl = () => {
    child.stderr.write('TerminalQuotaError: You have exhausted your daily quota on this model.');
    return child;
  };

  const result = await runGemini('質問', undefined, {
    env: { ORGIAST_GEMINI_TIMEOUT_MS: '50' },
    platform: 'linux',
    spawnImpl,
  });

  assert.equal(result.ok, false);
  assert.match(result.text, /TerminalQuotaError: You have exhausted your daily quota/);
});
