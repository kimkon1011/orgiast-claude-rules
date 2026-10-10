import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'llm-ask.mjs');

// 実キーを消し、鍵ファイルの無い一時 home を使う。こうすると機密を送らない限り
// どのプロバイダへも HTTP リクエストが出ない(統合テストが実 API を叩かない)。
const KEY_ENVS = ['OPENROUTER_API_KEY', 'GROQ_API_KEY', 'ZAI_API_KEY', 'CEREBRAS_API_KEY', 'GSK_PROXY_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'XAI_API_KEY', 'MOONSHOT_API_KEY', 'MISTRAL_API_KEY'];

function sandboxEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of KEY_ENVS) delete env[name];
  delete env.GEMINI_FREE_TIER;
  delete env.ORGIAST_EGRESS_RESTRICTED_PROVIDERS;
  env.ORGIAST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-ask-egress-'));
  return Object.assign(env, extra);
}

function runLlmAsk(args, extraEnv) {
  const env = sandboxEnv(extraEnv);
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 60_000, env });
  fs.rmSync(env.ORGIAST_HOME, { recursive: true, force: true });
  return result;
}

test('restricted プロバイダには機密を送らず exit 3 で止まる', () => {
  // 注意: プロンプトを `--` で始めると引数パーサが落とす(既存挙動)ので、機密は文中に置く。
  const result = runLlmAsk(['--provider', 'deepseek', 'この鍵を復号して -----BEGIN RSA PRIVATE KEY-----']);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /egress-guard: deepseek への送信を止めました/);
  assert.match(result.stderr, /private_key/);
  assert.equal(result.stdout, '');
});

test('秘密鍵は restricted でないプロバイダでも送らない', () => {
  const result = runLlmAsk(['--provider', 'openrouter', 'この鍵を説明して -----BEGIN RSA PRIVATE KEY-----']);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /egress-guard: openrouter への送信を止めました/);
  assert.match(result.stderr, /private_key/);
});

test('メール・電話の大量は restricted への送信を止める', () => {
  const result = runLlmAsk(['--provider', 'kimi', 'a@example.com b@example.com c@example.com を名寄せして']);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /egress-guard: kimi への送信を止めました/);
  assert.match(result.stderr, /email_bulk/);
});

test('--system 側の機密も検出する', () => {
  const result = runLlmAsk(['--provider', 'glm', '--system', 'OPENROUTER_API_KEY=sk-live-0123456789abcdef', '要約して']);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /glm への送信を止めました/);
});

test('機密が無ければガードは通す(送信前に止めない)', () => {
  const result = runLlmAsk(['--provider', 'deepseek', '普通の指示文です。要約してください。']);
  assert.notEqual(result.status, 3);
  assert.doesNotMatch(result.stderr, /egress-guard/);
});

test('メール・電話の大量でも restricted でないプロバイダは通す', () => {
  const result = runLlmAsk(['--provider', 'openrouter', 'a@example.com b@example.com c@example.com']);
  assert.notEqual(result.status, 3);
  assert.doesNotMatch(result.stderr, /egress-guard/);
});

test('フォールバック先が restricted なら其処だけ落として他候補へ回す', () => {
  // 先頭 groq は鍵が無くスキップ、鍵があるのは restricted な deepseek だけ。
  // ガードが効いていれば deepseek へは送信されず、ネットワークには一切出ない。
  const result = runLlmAsk(['--provider', 'groq', 'a@example.com b@example.com c@example.com'], { DEEPSEEK_API_KEY: 'dummy-key-for-test' });
  assert.notEqual(result.status, 3);
  assert.match(result.stderr, /egress-guard: フォールバック先 deepseek への送信を止めました/);
  assert.match(result.stderr, /deepseek\(no-request\)/);
  assert.equal(result.stdout, '');
});
