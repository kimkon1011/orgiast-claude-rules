import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { rescueTree } from './rescue-policy.mjs';
import { redactSecrets } from './webhook-health.mjs';
import { isEntry } from './is-entry.mjs';

const LOCK_ERROR_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// run-hidden.vbs holds `cmd /c ... >> sync-orgiast-main.log 2>&1` open for the whole
// run, so appending to that same file throws EBUSY. Retry briefly, then divert to a
// sibling events log: a log write must never turn a completed sync into a failure.
export async function appendLogLine(file, line, {
  retries = 3,
  delayMs = 100,
  fallbackFile = path.join(path.dirname(file), 'sync-orgiast-main.events.log'),
  appendImpl = fs.appendFileSync,
  sleepImpl = sleep,
} = {}) {
  const text = `${line}\n`;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      appendImpl(file, text);
      return { ok: true, file };
    } catch (error) {
      if (!LOCK_ERROR_CODES.has(error?.code)) return { ok: false, file, error };
      if (attempt < retries) await sleepImpl(delayMs);
    }
  }
  try {
    appendImpl(fallbackFile, text);
    return { ok: true, file: fallbackFile, fallback: true };
  } catch (error) {
    return { ok: false, file: fallbackFile, error };
  }
}

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
  const logFile = path.join(logs, 'sync-orgiast-main.log');
  for (const line of lines) {
    await appendLogLine(logFile, line);
    console.log(line);
  }
  if (result.failed) process.exitCode = 1;
}
