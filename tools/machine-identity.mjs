import os from 'node:os';
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
