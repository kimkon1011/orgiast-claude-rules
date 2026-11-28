#!/usr/bin/env node
// setup.mjs repair entry: recreate MorningBatch + attach next-actions/open-work + health.
import { runRegisterPs1 } from './lib/run-register-ps1.mjs';
import { getScheduledTaskInfo } from './lib/scheduled-task.mjs';
import { isEntry } from './is-entry.mjs';

export function morningTaskNeedsRepair(task, now = Date.now(), graceMs = 5 * 60 * 1000) {
  if (!task) return 'missing';
  if (String(task.state).toLowerCase() === 'disabled') return 'disabled';
  const nextRun = Date.parse(task.nextRunTime);
  if (!Number.isFinite(nextRun)) return 'next-run-missing';
  if (nextRun < now - graceMs) return 'next-run-past';
  return null;
}

export async function main({ platform = process.platform, getTaskInfo = getScheduledTaskInfo, now = Date.now(), ...options } = {}) {
  if (platform === 'win32') {
    const task = await getTaskInfo('OrgiastMorningBatch', options);
    const repairReason = morningTaskNeedsRepair(task, now);
    if (repairReason) {
      console.error(`OrgiastMorningBatch repair: ${repairReason}`);
      runRegisterPs1('register-morning-batch-task.ps1', { platform, ...options });
    }
  }
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
