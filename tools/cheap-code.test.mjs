import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendUsageLedger, autoProvider, buildChildEnv, cooldownUntilFromText, detectBillingFailure, detectUsageLimitText, readInstruction, resolveProvider, writeProviderCooldown } from './cheap-code.mjs';

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

test('usage-limit 本文(429 [1308])から provider 再開時刻をパースする', () => {
  const text = 'Error: 429 [1308] Usage limit reached for 5 hour. Your limit will reset at 2026-09-07 04:32:54';
  const now = new Date('2026-09-06T10:00:00+09:00').getTime();
  const until = cooldownUntilFromText(text, now);
  // 2026-09-07 04:32:54 を現地(JST=+09:00)として解釈した時刻になるはず(パーサの仕様)。
  assert.ok(until > now, 'reset 時刻がパースされていない');
  assert.ok(until - now > 5 * 60 * 60 * 1000 && until - now < 30 * 60 * 60 * 1000, `until=${new Date(until).toISOString()}`);
});

test('usage-limit 表記が無い text は +5h のフォールバック', () => {
  const now = Date.parse('2026-09-06T10:00:00Z');
  const until = cooldownUntilFromText('Connection reset by peer', now);
  assert.equal(until - now, 5 * 60 * 60 * 1000);
});

test('detectUsageLimitText は Usage limit reached / 429 / [1308] を検知する', () => {
  assert.equal(detectUsageLimitText('429 [1308] Usage limit reached for 5 hour'), true);
  assert.equal(detectUsageLimitText('HTTP 429 too many requests'), true);
  assert.equal(detectUsageLimitText('all good'), false);
});

test('402/Insufficient Balance と 429/Usage limit を分類し失敗台帳とcooldownへ残せる', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-code-402-'));
  const claude = path.join(home, '.claude'); const now = Date.now();
  assert.equal(detectBillingFailure('HTTP 402 Insufficient Balance'), 402);
  assert.equal(detectBillingFailure('429 Usage limit reached'), 429);
  appendUsageLedger({ home, provider: 'deepseek', model: 'x', promptChars: 4, outputChars: 0, secs: 1, ok: false, status: 402, now: new Date(now) });
  writeProviderCooldown({ claudeDir: claude, provider: 'deepseek', until: now + 86400000, reason: 'http_402', now });
  const row = JSON.parse(fs.readFileSync(path.join(claude, 'executor-usage.jsonl'), 'utf8'));
  assert.equal(row.ok, false); assert.equal(row.status, 402);
  assert.equal(JSON.parse(fs.readFileSync(path.join(claude, 'provider-cooldown.json'))).deepseek.until, now + 86400000);
});

test('writeProviderCooldown は usage_limit 履歴も残す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-code-cooldown-'));
  const claude = path.join(home, '.claude');
  const now = Date.now();
  const res = writeProviderCooldown({ claudeDir: claude, provider: 'glm', until: now + 5 * 60 * 60 * 1000, now });
  assert.equal(res.provider, 'glm');
  const state = JSON.parse(fs.readFileSync(path.join(claude, 'provider-cooldown.json'), 'utf8'));
  assert.equal(state.glm.reason, 'usage_limit');
  const history = fs.readFileSync(path.join(claude, 'provider-limit-history.jsonl'), 'utf8').trim();
  assert.match(history, /"provider":"glm"/);
});

test('auto: zai キー+クールダウンなしなら glm を選ぶ', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-code-auto-glm-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'zai.env'), 'ZAI_API_KEY=test\n', 'utf8');
  assert.equal(autoProvider({ home }), 'glm');
});

test('auto: glm が usage_limit クールダウン中なら deepseek を選ぶ', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-code-auto-cool-'));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'zai.env'), 'ZAI_API_KEY=test\n', 'utf8');
  writeProviderCooldown({ claudeDir: claude, provider: 'glm', until: Date.now() + 5 * 60 * 60 * 1000 });
  assert.equal(autoProvider({ home }), 'deepseek');
});

test('auto: zai キーが無い機体は deepseek のみ', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-code-auto-nozai-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  assert.equal(autoProvider({ home }), 'deepseek');
});

test('--provider auto は cooldown 中に deepseek を選んで dry-run に出す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-code-auto-cli-'));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(claude, { recursive: true });
  fs.writeFileSync(path.join(claude, 'zai.env'), 'ZAI_API_KEY=test\n', 'utf8');
  writeProviderCooldown({ claudeDir: claude, provider: 'glm', until: Date.now() + 5 * 60 * 60 * 1000 });
  const result = spawnSync(process.execPath, [tool, '--dry-run', '--provider', 'auto', '確認する'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home } });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).provider, 'deepseek');
});

test('明示 provider が cooldown 中なら claude を起動せず exit 3 で返す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cheap-code-explicit-cooldown-'));
  const claude = path.join(home, '.claude');
  try {
    fs.mkdirSync(claude, { recursive: true });
    fs.writeFileSync(path.join(claude, 'zai.env'), 'ZAI_API_KEY=test-key\n', 'utf8');
    fs.writeFileSync(path.join(claude, 'provider-cooldown.json'), JSON.stringify({ glm: { until: Date.now() + 3600000, reason: 'usage_limit' } }), 'utf8');
    const result = spawnSync(process.execPath, [tool, '--provider', 'glm', '--cwd', home, '確認する'], {
      encoding: 'utf8',
      env: { ...process.env, ORGIAST_HOME: home },
    });
    assert.equal(result.status, 3);
    assert.match(result.stderr, /クールダウン/);
    const ledger = fs.readFileSync(path.join(claude, 'executor-usage.jsonl'), 'utf8');
    assert.match(ledger, /"provider":"glm"/);
    assert.match(ledger, /"status":"cooldown"/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
