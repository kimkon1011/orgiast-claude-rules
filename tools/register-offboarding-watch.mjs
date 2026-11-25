#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { isEntry } from './is-entry.mjs';

export function main({ platform = process.platform, spawnImpl = spawnSync, home = process.env.ORGIAST_HOME || os.homedir(), label = resolveFleetLabel(home) } = {}) {
  if (platform !== 'win32' || label !== 'kim-PC') return 0;
  const script = fileURLToPath(new URL('./register-offboarding-watch.ps1', import.meta.url));
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `register-offboarding-watch exit=${result.status}`);
  console.log(result.stdout || 'OrgiastOffboardingWatch registered');
  return 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = process.argv.includes('--is-controller') ? (resolveFleetLabel(process.env.ORGIAST_HOME || os.homedir()) === 'kim-PC' ? 0 : 2) : main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
