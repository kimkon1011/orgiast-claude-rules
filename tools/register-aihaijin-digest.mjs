#!/usr/bin/env node
// setup --converge の repair から呼ぶ。Messenger 専用プロファイルがあるPCだけ登録する。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveRegisterRepoRoot } from './resolve-synced-repo.mjs';
import { isEntry } from './is-entry.mjs';
export function main({ home = process.env.ORGIAST_HOME || os.homedir(), platform = process.platform, exec = execFileSync, resolveRepo = resolveRegisterRepoRoot } = {}) {
  if (platform !== 'win32' || !fs.existsSync(path.join(home, '.claude', 'messenger-profile'))) return;
  const repo = resolveRepo({ fallback: path.resolve(import.meta.dirname, '..'), requiredPaths: ['tools/nightly-bootstrap.ps1', 'tools/aihaijin-digest.mjs', 'tools/register-aihaijin-digest.ps1'] });
  exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(repo, 'tools/register-aihaijin-digest.ps1')], { timeout: 60000, windowsHide: true, stdio: 'pipe', env: { ...process.env, ORGIAST_HOME: home } });
}
if (isEntry(import.meta.url)) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
