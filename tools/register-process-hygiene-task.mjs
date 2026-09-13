#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { registerHourlyTask } from './lib/scheduled-task.mjs';

export function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home ?? process.env.ORGIAST_HOME ?? process.env.USERPROFILE ?? os.homedir();
  const repo = deps.repo ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const sourceHidden = path.join(repo, 'tools', 'run-hidden.vbs');
  const installedDir = path.join(home, '.claude', 'tools');
  const installedHidden = path.join(installedDir, 'run-hidden.vbs');
  const dryRun = argv.includes('--dry-run');
  if (dryRun) {
    const plan = registerHourlyTask('OrgiastProcessHygiene', path.join(repo, 'tools', 'process-hygiene.mjs'), { home, dryRun: true });
    console.log(`PLAN: ${plan.taskName} hourly via run-hidden.vbs: node tools/process-hygiene.mjs --kill`);
    return plan;
  }
  if (process.platform !== 'win32') { console.log('OrgiastProcessHygiene: Windows以外では登録しません'); return null; }
  fs.mkdirSync(installedDir, { recursive: true });
  fs.copyFileSync(sourceHidden, installedHidden);
  registerHourlyTask('OrgiastProcessHygiene', path.join(repo, 'tools', 'process-hygiene.mjs'), { home, spawnImpl: deps.spawnImpl });
  console.log('OK: OrgiastProcessHygiene registered (hourly)');
  return true;
}

if (isEntry(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
