import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RESTRICTED_PROVIDERS,
  checkEgress,
  isRestrictedProvider,
  luhnValid,
  restrictedProviders,
  scanSensitive,
} from './egress-guard.mjs';

const types = (text) => scanSensitive(text).map((finding) => finding.type);
const env = {}; // 実環境の環境変数に依存させない

test('秘密鍵と PEM ブロックを検出する', () => {
  assert.deepEqual(types('-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n-----END RSA PRIVATE KEY-----'), ['private_key']);
  assert.deepEqual(types('-----BEGIN OPENSSH PRIVATE KEY-----'), ['private_key']);
  assert.deepEqual(types('-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----'), ['pem_block']);
});

test('API キー形式を検出する', () => {
  assert.ok(types('OPENAI=sk-abcdefghij0123456789ABCDEF').includes('api_key'));
  assert.ok(types('sk-ant-api03-abcdefghij0123456789').includes('api_key'));
  assert.ok(types('key=AIzaSyA1234567890abcdefghijklmnopqrstuv').includes('api_key'));
  assert.ok(types('ghp_0123456789abcdefghijklmnopqrstuvwx').includes('api_key'));
  assert.ok(types('github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz').includes('api_key'));
  assert.ok(types('xoxb-0123456789-abcdefghijklm').includes('api_key'));
  assert.ok(types('AKIAIOSFODNN7EXAMPLE').includes('api_key'));
});

test('JWT を検出する', () => {
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  assert.ok(types(`Authorization: Bearer ${jwt}`).includes('jwt'));
});

test('.env 形式の代入を検出し、プレースホルダと変数参照は無視する', () => {
  assert.ok(types('DEEPSEEK_API_KEY=sk-live-0123456789abcdef').includes('credential_assignment'));
  assert.ok(types('SERVICE_SECRET="a1b2c3d4e5f6"').includes('credential_assignment'));
  assert.ok(types('PASSWORD=hunter2secret').includes('credential_assignment'));
  assert.deepEqual(types('DEEPSEEK_API_KEY=${DEEPSEEK_KEY}'), []);
  assert.deepEqual(types('OPENROUTER_API_KEY=your_api_key_here'), []);
  assert.deepEqual(types('NODE_ENV=production'), []);
});

test('クレジットカードを Luhn で判定する', () => {
  assert.equal(luhnValid('4111111111111111'), true);
  assert.equal(luhnValid('4111111111111112'), false);
  assert.ok(types('カード: 4111 1111 1111 1111').includes('credit_card'));
  assert.ok(types('カード: 378282246310005').includes('credit_card'));
  assert.deepEqual(types('注文番号 4111111111111112'), []);
  assert.deepEqual(types('日付 2026-10-10 / 時刻 1760000000000'), []);
});

test('マイナンバーは「個人番号」語の近傍だけ検出する', () => {
  assert.ok(types('個人番号は 123456789012 です').includes('mynumber'));
  assert.ok(types('マイナンバー: 123456789012').includes('mynumber'));
  assert.deepEqual(types('管理ID 123456789012 のレコード'), []);
});

test('メール・電話は 3 件以上でだけ大量検出になる', () => {
  assert.deepEqual(types('連絡先は a@example.com です'), []);
  assert.ok(types('a@example.com b@example.com c@example.com').includes('email_bulk'));
  assert.deepEqual(types('電話は 03-1234-5678 です'), []);
  assert.ok(types('03-1234-5678 / 06-1234-5678 / 090-1234-5678').includes('phone_bulk'));
});

test('`sk-` をまたぐ普通の単語・短い断片は誤検知しない', () => {
  assert.deepEqual(types('リスク(risk)管理の task-list と risk-management-framework-2026'), []);
  assert.deepEqual(types('sk-abc'), []);
  assert.deepEqual(types('disk-usage-report-daily'), []);
});

test('restricted プロバイダの判定は設定で拡張できる', () => {
  assert.deepEqual([...RESTRICTED_PROVIDERS], ['kimi', 'deepseek', 'glm']);
  for (const name of ['kimi', 'deepseek', 'glm']) assert.equal(isRestrictedProvider(name, env), true, name);
  for (const name of ['openrouter', 'groq', 'cerebras', 'genspark', 'grok', 'mistral']) assert.equal(isRestrictedProvider(name, env), false, name);
  assert.equal(isRestrictedProvider('gemini', env), false);
  assert.equal(isRestrictedProvider('gemini', { GEMINI_FREE_TIER: '1' }), true);
  assert.equal(isRestrictedProvider('gemini-cli', { GEMINI_FREE_TIER: 'true' }), true);
  assert.equal(isRestrictedProvider('xai-proxy', { ORGIAST_EGRESS_RESTRICTED_PROVIDERS: 'xai-proxy, mistral' }), true);
  assert.ok(restrictedProviders({ ORGIAST_EGRESS_RESTRICTED_PROVIDERS: 'a,b' }).includes('a'));
});

test('機密そのものは restricted でないプロバイダへも送らない', () => {
  const text = '-----BEGIN RSA PRIVATE KEY-----';
  for (const provider of ['deepseek', 'kimi', 'glm', 'openrouter', 'groq', 'cerebras', 'grok']) {
    const verdict = checkEgress({ provider, text, env });
    assert.equal(verdict.allowed, false, provider);
    assert.match(verdict.reason, /private_key/);
  }
  assert.equal(checkEgress({ provider: 'openrouter', text: 'DEEPSEEK_API_KEY=sk-live-0123456789abcdef', env }).allowed, false);
  assert.equal(checkEgress({ provider: 'openrouter', text: 'カード: 4111 1111 1111 1111', env }).allowed, false);
});

test('メール・電話の大量は restricted の時だけ止める', () => {
  const text = 'a@example.com b@example.com c@example.com';
  assert.equal(checkEgress({ provider: 'deepseek', text, env }).allowed, false);
  assert.equal(checkEgress({ provider: 'kimi', text, env }).allowed, false);
  assert.equal(checkEgress({ provider: 'glm', text, env }).allowed, false);
  assert.equal(checkEgress({ provider: 'openrouter', text, env }).allowed, true);
  assert.equal(checkEgress({ provider: 'gemini', text, env }).allowed, true);
  assert.equal(checkEgress({ provider: 'gemini', text, env: { GEMINI_FREE_TIER: '1' } }).allowed, false);
});

test('機密が無ければ全プロバイダで許可する', () => {
  const text = '通常の指示文です。テストの実行結果を要約してください。';
  for (const provider of ['deepseek', 'kimi', 'glm', 'openrouter']) {
    const verdict = checkEgress({ provider, text, env });
    assert.equal(verdict.allowed, true, provider);
    assert.deepEqual(verdict.findings, []);
    assert.equal(verdict.reason, '');
  }
});

test('findings は種別ごとに1件で、sample は先頭4字+*** のみ', () => {
  const secret = 'sk-abcdefghij0123456789ABCDEF';
  const findings = scanSensitive(`key=${secret}`);
  assert.equal(findings.length, new Set(findings.map((finding) => finding.type)).size);
  const apiKey = findings.find((finding) => finding.type === 'api_key');
  assert.equal(apiKey.sample, 'sk-a***');
  assert.equal(JSON.stringify(findings).includes('abcdefghij'), false);
  assert.equal(JSON.stringify(findings).includes(secret), false);
});

test('事前計算した findings を渡しても同じ判定になる', () => {
  const text = '-----BEGIN RSA PRIVATE KEY-----';
  const findings = scanSensitive(text);
  assert.deepEqual(checkEgress({ provider: 'kimi', findings, env }), checkEgress({ provider: 'kimi', text, env }));
});
