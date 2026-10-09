import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { rescueTree } from './rescue-policy.mjs';
import { redactSecrets } from './webhook-health.mjs';
import { isEntry } from './is-entry.mjs';

export async function syncTree(tree, home, options = {}) {
  const result = await rescueTree(tree, home, { ...options, preserveTree: true });
  if (!result.clean) return result;
  const git = args => {
    const r = spawnSync('git', ['-C', tree, ...args], { encoding: 'utf8', timeout: 120000, windowsHide: true });
    if (r.error || r.status !== 0) throw new Error(`${args[0]} failed: ${redactSecrets(r.stderr || r.error?.message || String(r.status))}`);
    return r.stdout.trim();
  };
  try {
    git(['fetch', 'origin', 'main', '--quiet']);
    const check = await rescueTree(tree, home, { ...options, preserveTree: true });
    result.events.push(...check.events);
    if (!check.clean) return { ...check, events: result.events };
    const before = git(['rev-parse', '--short', 'HEAD']);
    // Non-forced checkout refuses conflicting edits; never clean excluded work directories.
    git(['checkout', '--detach', '--no-overwrite-ignore', 'origin/main', '--quiet']);
    const after = git(['rev-parse', '--short', 'HEAD']);
    result.events.push({ step: 'SYNC_OK', message: before === after ? `ok (no change, ${after})` : `updated ${before} -> ${after}` });
  } catch (error) {
    result.events.push({ step: 'SYNC_FAILED', message: redactSecrets(error.message) });
    result.failed = true;
  }
  return result;
}

if (isEntry(import.meta.url)) {
  const home = process.env.ORGIAST_HOME || os.homedir();
  const tree = process.argv[2] || path.join(home, 'orgiast-main');
  const logs = path.join(home, '.claude', 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const result = await syncTree(tree, home);
  const lines = result.events.map(e => `${new Date().toISOString()} ${e.step} ${e.message}`);
  if (!result.clean) lines.push(`${new Date().toISOString()} skipped (dirty: ${result.dirtyCount ?? 'unknown'} paths)`);
  for (const line of lines) {
    fs.appendFileSync(path.join(logs, 'sync-orgiast-main.log'), `${line}\n`);
    console.log(line);
  }
  if (result.failed) process.exitCode = 1;
}
