#!/usr/bin/env node
// setup.mjs repair entry: recreate MorningBatch + attach next-actions/open-work + health.
import { runRegisterPs1 } from './lib/run-register-ps1.mjs';
import { getScheduledTaskInfo } from './lib/scheduled-task.mjs';
import { isEntry } from './is-entry.mjs';

export async function main({ platform = process.platform, getTaskInfo = getScheduledTaskInfo, ...options } = {}) {
  runRegisterPs1('register-nightly-tools.ps1', { platform, ...options });
  if (platform === 'win32') {
    if (!await getTaskInfo('OrgiastMorningBatch', options)) {
      throw new Error('read-back failed: OrgiastMorningBatch');
    }
  }
  try {
    runRegisterPs1('register-nightly-remediate-task.ps1', { platform, ...options });
  } catch (error) {
    // Remediate is independent; morning/next-actions registration already succeeded.
    console.error(`register-nightly-remediate-task.ps1: ${error.message || error}`);
  }
  return 0;
}

if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
