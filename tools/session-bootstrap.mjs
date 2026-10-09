#!/usr/bin/env node
// Project SessionStart supplies the first hook for a new OS user. User settings are per HOME.
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
export function bootstrapUser({ home = process.env.ORGIAST_HOME || os.homedir(),
  repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), platform = process.platform, run = spawnSync } = {}) {
  if (process.env.CLAUDE_CODE_REMOTE === 'true') return { skipped: 'cloud' };
  if (!['win32', 'darwin', 'linux'].includes(platform)) return { skipped: 'platform' };
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  const registration = run(process.execPath, [path.join(repo, 'tools/register-hooks.mjs'), '--hooks-only'],
    { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (registration.status !== 0) throw new Error('user hook registration failed');
  // Hooks registered after startup take effect next session, so sync now as well.
  const sync = run(process.execPath, [path.join(repo, 'tools/onboarding-sync.mjs')],
    { env, encoding: 'utf8', windowsHide: true, timeout: 300000 });
  return { registered: true, syncExit: sync.status };
}
if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(bootstrapUser())); }
  catch { console.error('session-bootstrap failed'); process.exitCode = 1; }
}
