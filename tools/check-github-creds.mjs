#!/usr/bin/env node
// check-github-creds.mjs — GitHub 資格情報がこのPCで有効か確認する
// 用途: auto-progress の check として使う（exit 0=有効, exit 1=無効）
// このPCのgit credential fillがseisaku-team-orgのトークンを返すか検証する。
// パスワード（トークン）は標準出力に出さずに検証する。
// GCM_INTERACTIVE=never でGUI/プロンプト表示を禁止する（ヘッドレス時に
// キャッシュ喪失で確定失敗させるため。無ければkimのデスクトップに認証UIが出る）。
import { spawnSync } from 'node:child_process';

const result = spawnSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
  timeout: 15000,
  maxBuffer: 4096,
  env: { ...process.env, GCM_INTERACTIVE: 'never' },
  // ヘッドレス実行時にコンソール窓を出さない（repo invariant: windowsHide必須）
  windowsHide: true,
});

if (result.error || result.status !== 0) {
  console.error(`credential fill 失敗: ${result.error?.message || `exit ${result.status}`}`);
  process.exit(1);
}

const output = (result.stdout || '').trim();
const lines = output.split('\n');
const password = lines.find(l => l.startsWith('password='));
const username = lines.find(l => l.startsWith('username='));

if (!password || !username) {
  console.error('credential fill の応答に password または username が見つかりません');
  process.exit(1);
}

// トークンが空でないことを確認（中身は出力しない）
const token = password.split('=', 2)[1];
if (!token || token.length < 10) {
  console.error(`トークンが空または短すぎます (${String(token || '').length}文字)`);
  process.exit(1);
}

console.log(`GitHub 資格情報: 有効 (${username.split('=', 2)[1]}, トークン${token.length}文字)`);
process.exit(0);