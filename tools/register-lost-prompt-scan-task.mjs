#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { registerHourlyTask } from './lib/scheduled-task.mjs';
import { journalHome } from './prompt-journal.mjs';
import { resolveRegisterRepoRoot } from './resolve-synced-repo.mjs';

export function registerLostPromptScan({ home = journalHome(), dryRun = false } = {}) {
  const repo = resolveRegisterRepoRoot({
    fallback: fileURLToPath(new URL('..', import.meta.url)),
    requiredPaths: ['tools/lost-prompt-scan.mjs', 'tools/run-hidden.vbs'],
    env: { ...process.env, ORGIAST_HOME: home },
  });
  if (!dryRun) {
    if (process.platform !== 'win32') throw new Error('Task Scheduler requires Windows');
    const dir = path.join(home, '.claude', 'tools');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(repo, 'tools', 'run-hidden.vbs'), path.join(dir, 'run-hidden.vbs'));
  }
  return registerHourlyTask('OrgiastLostPromptScan', path.join(repo, 'tools', 'lost-prompt-scan.mjs'), {
    home, dryRun, scriptArgs: [], description: 'Detect Claude Code prompts missing from local transcripts (hourly)',
  });
}

if (isEntry(import.meta.url)) {
  try {
    const plan = registerLostPromptScan({ dryRun: process.argv.includes('--dry-run') });
    console.log(plan ? JSON.stringify(plan) : 'OK: OrgiastLostPromptScan registered (hourly)');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
