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

test('Windows fallback reads preferred WSL distro with bounded read-only commands', async t => {
  const { codexAuthStatusAny } = await import('./codex-auth-status.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-any-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const calls = [];
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    return { status: 0, stdout: args[0] === '-l' ? 'Debian\r\nUbuntu\r\n' : JSON.stringify({ tokens: { id_token: fixtureJwt({ email: 'wsl@example.com' }) } }) };
  };
  assert.deepEqual(codexAuthStatusAny(home, { platform: 'win32', spawnImpl }), { login: true, email: 'wsl@example.com', plan: null, source: 'wsl' });
  assert.deepEqual(calls.map(c => c.args), [['-l', '-q'], ['-d', 'Ubuntu', '--', 'sh', '-c', 'cat "$HOME/.codex/auth.json"']]);
  assert.deepEqual(calls.map(c => c.options), ['utf16le', 'utf8'].map(encoding => ({ encoding, windowsHide: true, timeout: 15000 })));
  assert.ok(calls.every(c => c.command === 'wsl'));
  let unexpectedSpawns = 0;
  const forbiddenSpawn = () => { unexpectedSpawns++; throw new Error('must not spawn'); };
  assert.equal(codexAuthStatusAny(home, { platform: 'linux', spawnImpl: forbiddenSpawn }).login, false);
  fs.mkdirSync(path.join(home, '.codex'));
  fs.writeFileSync(path.join(home, '.codex/auth.json'), JSON.stringify({ tokens: { id_token: fixtureJwt({ email: 'win@example.com' }) } }));
  assert.deepEqual(codexAuthStatusAny(home, { platform: 'win32', spawnImpl: forbiddenSpawn }), { login: true, email: 'win@example.com', plan: null, source: 'windows' });
  assert.equal(unexpectedSpawns, 0);
});

test('WSL missing, timeout, exceptions and malformed auth fail closed', async t => {
  const { codexAuthStatusAny } = await import('./codex-auth-status.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-missing-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  for (const result of [{ status: 1 }, { status: null, error: new Error('timeout') }, { status: 0, stdout: '{bad' }, { status: 0, stdout: '{}' }, { status: 0, stdout: '' }]) {
    const spawnImpl = (_, args) => args[0] === '-l' ? { status: 0, stdout: 'Ubuntu' } : result;
    assert.deepEqual(codexAuthStatusAny(home, { platform: 'win32', spawnImpl }), { login: false, email: null, plan: null, source: null });
  }
  for (const spawnImpl of [() => ({ status: 1 }), () => ({ status: 0, stdout: '' }), () => { throw new Error('unavailable'); }]) {
    assert.equal(codexAuthStatusAny(home, { platform: 'win32', spawnImpl }).login, false);
  }
});
