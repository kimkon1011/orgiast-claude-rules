import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { codexAuthStatus, formatCodexLogin } from './codex-auth-status.mjs';

function fixtureJwt(payload) {
  return `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.dummy-signature`;
}

function readStatus(t, contents) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-auth-status-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  if (contents !== undefined) {
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(home, '.codex', 'auth.json'), contents);
  }
  return codexAuthStatus(home);
}

test('id_token の email と入れ子のプランを優先し、トークンを返さない', (t) => {
  const token = fixtureJwt({ email: 'codex@example.com', 'https://api.openai.com/auth': { chatgpt_plan_type: 'prolite' }, chatgpt_plan_type: 'wrong' });
  const accessToken = fixtureJwt({ email: 'other@example.com' });
  const status = readStatus(t, JSON.stringify({ tokens: { id_token: token, access_token: accessToken, refresh_token: 'dummy-refresh' } }));
  assert.deepEqual(status, { login: true, email: 'codex@example.com', plan: 'prolite' });
  for (const secret of [token, accessToken, 'dummy-refresh']) assert.equal(JSON.stringify(status).includes(secret), false);
});

test('access_token と profile email にフォールバックし、トップレベルのプランを無視する', (t) => {
  for (const id_token of [undefined, '']) {
    const status = readStatus(t, JSON.stringify({ tokens: { id_token, access_token: fixtureJwt({ 'https://api.openai.com/profile': { email: 'fallback@example.com' }, chatgpt_plan_type: 'wrong' }) } }));
    assert.deepEqual(status, { login: true, email: 'fallback@example.com', plan: null });
  }
});

test('ファイル無し・欠損・空文字・壊れた JSON は未ログイン', (t) => {
  for (const contents of [undefined, '', '{broken', 'null', '{}', '{"tokens":{}}', '{"tokens":[]}', '{"tokens":{"id_token":"","access_token":""}}']) {
    assert.deepEqual(readStatus(t, contents), { login: false, email: null, plan: null });
  }
});

test('既存挙動どおり壊れた JWT や email 欠落でもトークンがあればログイン済', (t) => {
  for (const token of ['invalid-jwt', fixtureJwt({})]) {
    assert.deepEqual(readStatus(t, JSON.stringify({ tokens: { id_token: token } })), { login: true, email: null, plan: null });
  }
});

test('BOM 付き認証ファイルも読める', (t) => {
  assert.deepEqual(readStatus(t, '\uFEFF' + JSON.stringify({ tokens: { id_token: fixtureJwt({ email: 'codex@example.com' }) } })), { login: true, email: 'codex@example.com', plan: null });
});

test('formatCodexLogin の全5分岐とプラン省略・認証ファイル優先', () => {
  assert.equal(formatCodexLogin({ login: true, email: 'codex@example.com', plan: 'prolite' }, false), '済(codex@example.com/prolite)');
  assert.equal(formatCodexLogin({ login: true, email: 'codex@example.com', plan: null }), '済(codex@example.com)');
  assert.equal(formatCodexLogin({ login: true, email: null, plan: 'prolite' }, false), '済');
  assert.equal(formatCodexLogin({ login: false }, true), '済');
  assert.equal(formatCodexLogin({ login: false }, false), '未');
  assert.equal(formatCodexLogin({ login: false }, undefined), '判定不能');
  assert.equal(formatCodexLogin({ login: 1, email: 'codex@example.com' }, false), '未');
});
