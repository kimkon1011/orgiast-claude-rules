import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildChildEnv, readInstruction, resolveProvider } from './cheap-code.mjs';

const tool = fileURLToPath(new URL('./cheap-code.mjs', import.meta.url));

function run(args) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-code-home-'));
  return spawnSync(process.execPath, [tool, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: home },
  });
}

test('provider 未指定では DeepSeek の base を選ぶ', () => {
  const result = run(['--dry-run', '確認する']);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).base, 'https://api.deepseek.com/anthropic');
});

test('--provider glm では Z.ai の base を選ぶ', () => {
  const result = run(['--dry-run', '--provider', 'glm', '確認する']);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).base, 'https://api.z.ai/api/anthropic');
});

test('不正な provider 名はエラーになる', () => {
  const result = run(['--dry-run', '--provider', 'unknown', '確認する']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /不正な provider/);
});

test('--model が provider の既定モデルを上書きする', () => {
  const result = run(['--dry-run', '--model', 'custom-model', '確認する']);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).model, 'custom-model');
});

test('--prompt-file から指示を読める', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-code-prompt-'));
  try {
    const file = path.join(directory, 'prompt.md');
    fs.writeFileSync(file, 'ファイル `sample.mjs` を作る\n', 'utf8');
    assert.equal(readInstruction(file, []), 'ファイル `sample.mjs` を作る');
    const result = run(['--dry-run', '--prompt-file', file]);
    assert.equal(result.status, 0);
    assert.match(JSON.parse(result.stdout).argv[2], /`sample\.mjs`/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('子 env だけに Anthropic 接続設定を追加し process.env を汚染しない', () => {
  const beforeBase = process.env.ANTHROPIC_BASE_URL;
  const beforeToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const config = resolveProvider('deepseek');
  const childEnv = buildChildEnv(config, 'test-secret', { SAFE_PARENT: 'yes' });
  assert.equal(childEnv.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
  assert.equal(childEnv.ANTHROPIC_AUTH_TOKEN, 'test-secret');
  assert.equal(childEnv.SAFE_PARENT, 'yes');
  assert.equal(process.env.ANTHROPIC_BASE_URL, beforeBase);
  assert.equal(process.env.ANTHROPIC_AUTH_TOKEN, beforeToken);
});
