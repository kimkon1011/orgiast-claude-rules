#!/usr/bin/env node
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRegisterRepoRoot } from './resolve-synced-repo.mjs';
import { isEntry } from './is-entry.mjs';
export function main({ platform = process.platform, exec = execFileSync } = {}) {
  if (platform !== 'win32') return;
  const repo = resolveRegisterRepoRoot({ fallback: path.resolve(import.meta.dirname, '..'), requiredPaths: ['tools/nightly-bootstrap.ps1', 'tools/stalled-session-resume.mjs'] });
  exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'tools/register-stalled-session-nightly.ps1')], { timeout: 60000, windowsHide: true, stdio: 'pipe' });
}
if (isEntry(import.meta.url)) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
