import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function machineIdentity() {
  let gitEmail = '未設定';
  try {
    const result = spawnSync('git', ['config', '--global', 'user.email'], {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    });
    const value = result.status === 0 ? result.stdout.trim() : '';
    if (value) gitEmail = value;
  } catch {}
  return {
    hostname: os.hostname(),
    username: os.userInfo().username,
    gitEmail,
  };
}

// Claude Code のログインアカウント(~/.claude.json の oauthAccount.emailAddress)。
// git user.email とは別物。取れなければ null(例外は投げない)。
export function getClaudeAccountEmail(home = process.env.ORGIAST_HOME || os.homedir()) {
  try {
    const json = JSON.parse(fs.readFileSync(path.join(home, '.claude.json'), 'utf8').replace(/^﻿/, ''));
    const account = json?.oauthAccount?.emailAddress;
    return typeof account === 'string' && /^[^\s@]+@[^\s@]+$/.test(account) ? account : null;
  } catch { return null; }
}

// OS 表記: "darwin 24.1.0" 形式(platform + release)。
export function osDescription() {
  return `${process.platform} ${os.release()}`;
}

// Mac のシリアル。Mac 以外・取得失敗は null(呼び出し側は省略する)。
export function macSerial(run = spawnSync, platform = process.platform) {
  if (platform !== 'darwin') return null;
  try {
    const result = run('ioreg', ['-l'], { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 });
    const match = /"IOPlatformSerialNumber"\s*=\s*"([^"]+)"/.exec(result?.status === 0 ? result.stdout : '');
    return match ? match[1] : null;
  } catch { return null; }
}

// 報告(フリートシート payload / Discord)へ載せる追加識別。省略可能な値は含めない。
export function reportExtras(home) {
  const extras = { claudeAccount: getClaudeAccountEmail(home) || '', hostname: os.hostname(), os: osDescription() };
  const serial = macSerial();
  if (serial) extras.serial = serial;
  return extras;
}
