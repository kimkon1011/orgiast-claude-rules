#!/usr/bin/env node
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { probeTask } from './register-fleet-mail.mjs';
import { isEntry } from './is-entry.mjs';

export const TASK_NAME = 'OrgiastFleetChase';
export function main({ home = process.env.ORGIAST_HOME || os.homedir(), platform = process.platform,
  spawnImpl = spawnSync, ensure = false, stdout = console.log } = {}) {
  if (resolveFleetLabel(home) !== 'kim-PC' || platform !== 'win32') return 0;
  if (ensure && probeTask(spawnImpl, TASK_NAME) === 'ok') return 0;
  const script = fileURLToPath(new URL('./register-fleet-chase.ps1', import.meta.url));
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ORGIAST_HOME: home },
  });
  if (result.error || result.status !== 0) throw new Error('OrgiastFleetChase 登録失敗');
  if (probeTask(spawnImpl, TASK_NAME) !== 'ok') throw new Error('OrgiastFleetChase 登録後の健全性確認失敗');
  stdout('OrgiastFleetChase registered (every 30 minutes)');
  return 0;
}
if (isEntry(import.meta.url)) {
  try {
    if (process.argv.includes('--is-controller')) {
      process.exitCode = resolveFleetLabel(process.env.ORGIAST_HOME || os.homedir()) === 'kim-PC' ? 0 : 2;
    } else {
      process.exitCode = main({ ensure: process.argv.includes('--ensure') });
    }
  }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
