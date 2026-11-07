#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { getScheduledTaskInfo } from './lib/scheduled-task.mjs';
import { runRegisterPs1 } from './lib/run-register-ps1.mjs';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import os from 'node:os';
export async function main({ platform = process.platform, home = process.env.ORGIAST_HOME || os.homedir(), getTaskInfo = getScheduledTaskInfo, ...options } = {}) {
  if (resolveFleetLabel(home) !== 'kim-PC') return 0;
  runRegisterPs1('register-stuck-pr-task.ps1', { platform, ...options });
  if (platform === 'win32' && !await getTaskInfo('OrgiastStuckPrSweeper', options)) throw new Error('read-back failed: OrgiastStuckPrSweeper');
  return 0;
}
if (isEntry(import.meta.url)) { try { process.exitCode = await main(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
