#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export function main({ dryRun = false, platform = process.platform, run = spawnSync } = {}) {
  const plan = {
    file: 'powershell.exe',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./register-task-hide-guard.ps1', import.meta.url))],
    options: { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] },
  };
  if (dryRun) return plan;
  if (platform !== 'win32') return null;
  const result = run(plan.file, plan.args, plan.options);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `task-hide-guard registration exit=${result.status}`);
  console.log(result.stdout);
  return plan;
}
if (isEntry(import.meta.url)) {
  try {
    const dryRun = process.argv.includes('--dry-run');
    const result = main({ dryRun });
    if (dryRun) console.log(JSON.stringify(result));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
