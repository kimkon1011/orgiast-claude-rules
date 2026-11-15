#!/usr/bin/env node
// delegation-ratio-watch を毎日 05:40 に実行する schtasks 登録。
// satou-secretary-daily-register.mjs のパターンに従う。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export const TASK_NAME = 'ClaudeDelegationRatioWatch';
export const TASK_TIME = '05:40';

export function taskCommand({ node = process.execPath, script = fileURLToPath(new URL('./delegation-ratio-watch.mjs', import.meta.url)), home = os.homedir() } = {}) {
  const dir = path.join(home, '.claude', 'delegation-ratio-watch');
  const log = path.join(dir, 'run.log');
  return { dir, log, task: `"${node}" "${script}"`, node, script };
}

export function register({ spawn = spawnSync, node = process.execPath, home = os.homedir() } = {}) {
  if (process.platform !== 'win32') throw new Error('Windows only');
  const c = taskCommand({ node, home });
  fs.mkdirSync(c.dir, { recursive: true });
  const args = ['/create', '/f', '/tn', TASK_NAME, '/sc', 'daily', '/st', TASK_TIME, '/tr', c.task];
  const made = spawn('schtasks.exe', args, { encoding: 'utf8', windowsHide: true });
  if (made.status !== 0) throw new Error(`schtasks create failed: ${made.stderr || made.stdout}`);
  const query = spawn('schtasks.exe', ['/query', '/tn', TASK_NAME, '/fo', 'list', '/v'], { encoding: 'utf8', windowsHide: true });
  if (query.status !== 0) throw new Error(`schtasks query failed: ${query.stderr || query.stdout}`);
  return { create: made.stdout.trim(), query: query.stdout.trim(), command: c.task };
}

if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(register(), null, 2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}