#!/usr/bin/env node
// check-github-creds.mjs — GitHub 資格情報がこのPCで有効か確認する
// 用途: auto-progress 等の check として使う（exit 0=有効, exit 1=無効）
// git credential fill が seisaku-team-org 等の有効トークンを返すか検証する。
// パスワード（トークン）は標準出力に出さずに検証する。
// ※確認のみで、資格情報の導出・保存・再設定は行わない。
import { isEntry } from './is-entry.mjs';
import { spawnSync } from 'node:child_process';

export function parseCredentialOutput(stdout) {
  const lines = String(stdout || '').split('\n');
  let username = null;
  let token = null;
  for (const line of lines) {
    if (line.startsWith('username=')) {
      username = line.slice('username='.length);
    } else if (line.startsWith('password=')) {
      // '=' を区切りにせず先頭の 'password=' を除く（トークン内の '=' を保持）
      token = line.slice('password='.length);
    }
  }
  return { username, token };
}

export function verifyCredentials({ username, token }) {
  if (!username || !token) return { ok: false, reason: '応答に username または password がありません' };
  // トークンが空でないことを確認（中身は出力しない）
  if (token.length < 10) return { ok: false, reason: `トークンが空または短すぎます (${token.length}文字)` };
  return { ok: true, username, tokenLength: token.length };
}

export function runCheck({ timeoutMs = 15000 } = {}) {
  const result = spawnSync('git', ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 4096,
    // 対話プロンプト（GUI・端末）を無効化し、無期限ハングを防ぐ
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });

  if (result.error || result.status !== 0) {
    return { ok: false, reason: `credential fill 失敗: ${result.error?.message || `exit ${result.status}`}` };
  }

  const parsed = parseCredentialOutput(result.stdout);
  return verifyCredentials(parsed);
}

if (isEntry(import.meta.url)) {
  const { ok, reason, username, tokenLength } = runCheck();
  if (!ok) {
    console.error(reason);
    process.exit(1);
  }
  console.log(`GitHub 資格情報: 有効 (${username}, トークン${tokenLength}文字)`);
}