import assert from 'node:assert/strict';
import test from 'node:test';
import { parseCredentialOutput, verifyCredentials } from './check-github-creds.mjs';

test('通常応答は username と token を返す', () => {
  const parsed = parseCredentialOutput('protocol=https\nhost=github.com\nusername=seisaku-team-org\npassword=ghp_0123456789abcdef012345\n');
  assert.equal(parsed.username, 'seisaku-team-org');
  assert.equal(parsed.token, 'ghp_0123456789abcdef012345');
});

test('トークンに = が含まれても欠落しない', () => {
  // 区切り "password=" の除去には slice、split(',2') では '=' 以降が消える
  const parsed = parseCredentialOutput('protocol=https\nusername=u\npassword=abc=def=\n');
  assert.equal(parsed.token, 'abc=def=');
});

test('password 行がない場合は token が null', () => {
  const parsed = parseCredentialOutput('protocol=https\nusername=u\n');
  assert.equal(parsed.token, null);
});

test('username がない場合は username が null', () => {
  const parsed = parseCredentialOutput('protocol=https\npassword=abcdefghij\n');
  assert.equal(parsed.username, null);
});

test('verify: 有効トークンは ok', () => {
  const v = verifyCredentials({ username: 'seisaku-team-org', token: 'ghp_0123456789' });
  assert.equal(v.ok, true);
  assert.equal(v.tokenLength, 14);
});

test('verify: トークン8文字は短すぎて ng', () => {
  const v = verifyCredentials({ username: 'u', token: '12345678' });
  assert.equal(v.ok, false);
  assert.match(v.reason, /短すぎ/);
});

test('verify: token 欠落は ng', () => {
  assert.equal(verifyCredentials({ username: 'u', token: null }).ok, false);
  assert.equal(verifyCredentials({ username: 'u', token: '' }).ok, false);
});

test('verify: username 欠落は ng', () => {
  assert.equal(verifyCredentials({ username: null, token: 'abcdefghij' }).ok, false);
});