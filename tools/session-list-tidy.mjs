#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export function resolvePython() {
  for (const command of ['python3', 'python', 'py']) {
    const result = spawnSync(command, ['-c', '1'], { stdio: 'ignore', windowsHide: true });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

function main() {
  const python = resolvePython();
  if (!python) return;
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'purge-hidden-sessions.py');
  const args = [script];
  if (!process.argv.includes('--once')) args.push('--start-watcher');
  spawnSync(python, args, { stdio: 'ignore', windowsHide: true });
}

if (isEntry(import.meta.url)) main();
