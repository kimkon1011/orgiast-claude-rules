#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export function main({ platform = process.platform, spawnImpl = spawnSync, env = process.env } = {}) {
  if (platform !== 'win32') return 0;
  const script = fileURLToPath(new URL('./register-external-waiting.ps1', import.meta.url));
  // Let Windows PowerShell rebuild its module path instead of inheriting pwsh 7 modules.
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => key.toLowerCase() !== 'psmodulepath'));
  const result = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { env: childEnv, encoding: 'utf8', windowsHide: true, timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `register-external-waiting exit=${result.status}`);
  console.log(result.stdout || 'OrgiastExternalWaiting registered');
  return 0;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
