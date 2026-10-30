#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
export function main({ platform = process.platform, spawnImpl = spawnSync } = {}) {
  if (platform !== 'win32') return 0;
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./register-daytrip-detect-task.ps1', import.meta.url)), '-Ensure'], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `daytrip registration exit ${result.status}`);
  console.log(result.stdout); return 0;
}
if (isEntry(import.meta.url)) { try { process.exitCode = main(); } catch (e) { console.error(e.message); process.exitCode = 1; } }
