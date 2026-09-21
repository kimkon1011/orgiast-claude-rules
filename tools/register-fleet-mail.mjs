#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export function main({ home = process.env.ORGIAST_HOME || os.homedir(), platform = process.platform, spawnImpl = spawnSync } = {}) {
  if (platform !== 'win32' || !fs.existsSync(path.join(home, '.claude', 'fleet-sheet.env'))) return 0;
  const script = fileURLToPath(new URL('./register-fleet-mail.ps1', import.meta.url));
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `register-fleet-mail exit=${result.status}`);
  console.log(result.stdout || 'OrgiastFleetMail registered');
  return 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
