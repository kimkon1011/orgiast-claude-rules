#!/usr/bin/env node
// setup.mjs repair entry: ensure OrgiastMorningBatch exists, then attach next-actions.
import { runRegisterPs1 } from './lib/run-register-ps1.mjs';
import { getScheduledTaskInfo } from './lib/scheduled-task.mjs';
import { isEntry } from './is-entry.mjs';

export async function main({ platform = process.platform, getTaskInfo = getScheduledTaskInfo, ...options } = {}) {
  runRegisterPs1('register-morning-batch-task.ps1', { platform, ...options });
  // Attach open-work / next-actions / promote OrgiastNightlyHealth off the morning shell.
  runRegisterPs1('register-nightly-tools.ps1', { platform, ...options });
  if (platform === 'win32' && !await getTaskInfo('OrgiastMorningBatch', options)) {
    throw new Error('read-back failed: OrgiastMorningBatch');
  }
  return 0;
}

if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
