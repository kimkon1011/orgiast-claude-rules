#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './lib/stuck-dialog-state.mjs';
import { isEntry } from './is-entry.mjs';
import { resolveRegisterRepoRoot } from './resolve-synced-repo.mjs';
import { registerHourlyTask, getScheduledTaskInfo, startScheduledTask } from './lib/scheduled-task.mjs';
export async function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home || process.env.USERPROFILE || os.homedir();
  const ownTree = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const repo = deps.repo || resolveRegisterRepoRoot({ fallback: ownTree, requiredPaths: ['tools/stuck-dialog-watch.mjs', 'tools/run-hidden.vbs'] });
  const dryRun = argv.includes('--dry-run');
  if (!dryRun && (deps.platform || process.platform) !== 'win32') return null;
  if (argv.includes('--ensure') && !dryRun) {
    const info = await (deps.info || getScheduledTaskInfo)('OrgiastStuckDialogWatch', { spawnImpl: deps.spawnImpl });
    const hb = path.join(home, '.claude', 'heartbeat', 'stuck-dialog-watch.json');
    if (info && info.state !== 'Disabled' && fs.existsSync(hb) && readJson(hb).ok === true && Date.now() - fs.statSync(hb).mtimeMs < 600000) return { healthy: true };
  }
  if (!dryRun) {
    fs.mkdirSync(path.join(home,'.claude','tools'), { recursive: true });
    fs.copyFileSync(path.join(repo,'tools','run-hidden.vbs'),path.join(home,'.claude','tools','run-hidden.vbs'));
  }
  const plan = registerHourlyTask('OrgiastStuckDialogWatch',path.join(repo,'tools','stuck-dialog-watch.mjs'), {
    home, dryRun, spawnImpl: deps.spawnImpl, intervalMinutes: 5, initialDelayMinutes: 5,
    scriptArgs: ['loop','--seconds','290','--interval','2'], interactive: true,
    description: 'GUI dialog evidence and closure (5 minutes)',
  });
  if (!dryRun) await (deps.start || startScheduledTask)('OrgiastStuckDialogWatch', { spawnImpl: deps.spawnImpl });
  console.log(dryRun ? JSON.stringify(plan) : 'OK: OrgiastStuckDialogWatch registered (5 minutes, interactive user)');
  return plan;
}
if (isEntry(import.meta.url)) main().catch(e => { console.error(e.message); process.exitCode=1; });
