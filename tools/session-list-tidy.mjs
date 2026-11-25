#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { launchPurge } from './purge-sessions.mjs';
import { isEntry } from './is-entry.mjs';

export function resolvePython() {
  for (const command of ['python3', 'python', 'py']) {
    const result = spawnSync(command, ['-c', '1'], { stdio: 'ignore', windowsHide: true });
    if (!result.error && result.status === 0) return command;
  }
  return null;
}

function main() { launchPurge(); }

if (isEntry(import.meta.url)) main();
