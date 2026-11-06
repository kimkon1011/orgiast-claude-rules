#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { getScheduledTaskInfo } from './lib/scheduled-task.mjs';
import { runRegisterPs1 } from './lib/run-register-ps1.mjs';
export async function main({ platform = process.platform, getTaskInfo = getScheduledTaskInfo, ...options } = {}) {
  runRegisterPs1('register-kim-editor-sweep.ps1', { platform, ...options });
  if (platform === 'win32' && !await getTaskInfo('OrgiastKimEditorSweep', options)) throw new Error('read-back failed: OrgiastKimEditorSweep');
  return 0;
}
if (isEntry(import.meta.url)) { try { process.exitCode = await main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
