#!/usr/bin/env node
// check-github-creds.mjs — GitHub 資格情報がこのPCで有効か確認する
// 用途: auto-progress の check として使う（exit 0=有効, exit 1=無効）
// このPCのgit credential fillがseisaku-team-orgのトークンを返すか検証する。
// パスワード（トークン）は標準出力に出さずに検証する。
// GCM_INTERACTIVE=never でGUI/プロンプト表示を禁止する（ヘッドレス時に
// キャッシュ喪失で確定失敗させるため。無ければkimのデスクトップに認証UIが出る）。
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';

export function checkGithubCreds({ home = process.env.ORGIAST_HOME || os.homedir(), spawnImpl = spawnSync } = {}) {
  const spawnEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS: '' };
  const result = spawnImpl('git', ['-c', 'core.askPass=', 'credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    timeout: 15000,
    maxBuffer: 4096,
    cwd: home,
    env: spawnEnv,
    // ヘッドレス実行時にコンソール窓を出さない（repo invariant: windowsHide必須）
    windowsHide: true,
  });

  if (result?.error || result?.status !== 0) {
    return { ok: false, message: `credential fill 失敗: ${result?.error?.message || `exit ${result?.status}`}`, spawnEnv };
  }

  const output = (result.stdout || '').trim();
  const lines = output.split('\n');
  const password = lines.find(l => l.startsWith('password='));
  const username = lines.find(l => l.startsWith('username='));

  if (!password || !username) {
    return { ok: false, message: 'credential fill の応答に password または username が見つかりません', spawnEnv };
  }

  // トークンが空でないことを確認（中身は出力しない）
  const token = password.split('=', 2)[1];
  if (!token || token.length < 10) {
    return { ok: false, message: `トークンが空または短すぎます (${String(token || '').length}文字)`, spawnEnv };
  }

  const user = username.split('=', 2)[1];
  return { ok: true, user, tokenLength: token.length, message: `GitHub 資格情報: 有効 (${user}, トークン${token.length}文字)`, spawnEnv };
}

if (isEntry(import.meta.url)) {
  const res = checkGithubCreds();
  if (res.ok) {
    console.log(res.message);
    process.exitCode = 0;
  } else {
    console.error(res.message);
    process.exitCode = 1;
  }
}
