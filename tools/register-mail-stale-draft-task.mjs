#!/usr/bin/env node
// 送ると事故になる古い Gmail 下書きを1時間ごとに点検し、ラベル付与＋新規分だけ警告する（2026-10-26 三昌商事様）。
// 全PCに登録する。鍵が無いPCは取得失敗で何もしない。ラベル付与済みの下書きは再通知しないので、複数PCが走っても通知は1回。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { registerHourlyTask } from './lib/scheduled-task.mjs';
import { resolveRegisterRepoRoot } from './resolve-synced-repo.mjs';

export const TASK = 'OrgiastMailStaleDraft';
export function main(argv = process.argv.slice(2), deps = {}) {
  const home = deps.home ?? process.env.ORGIAST_HOME ?? process.env.USERPROFILE ?? os.homedir();
  const ownTree = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const repo = deps.repo ?? resolveRegisterRepoRoot({ fallback: ownTree, requiredPaths: [path.join('tools', 'mail-stale-draft.mjs'), path.join('tools', 'run-hidden.vbs')] });
  const sourceHidden = path.join(repo, 'tools', 'run-hidden.vbs');
  const installedDir = path.join(home, '.claude', 'tools');
  const installedHidden = path.join(installedDir, 'run-hidden.vbs');
  const opts = { home, intervalMinutes: 60, executionTimeLimitMinutes: 10, scriptArgs: ['--apply', '--notify'], initialDelayMinutes: 7, description: 'stale Gmail draft guard (hourly)' };
  if (argv.includes('--dry-run')) {
    const plan = registerHourlyTask(TASK, path.join(repo, 'tools', 'mail-stale-draft.mjs'), { ...opts, dryRun: true });
    console.log(`PLAN: ${plan.taskName} hourly: node tools/mail-stale-draft.mjs --apply --notify`);
    console.log(`PLAN: repo=${repo}`);
    return plan;
  }
  if (process.platform !== 'win32') { console.log(`${TASK}: Windows以外では登録しません`); return null; }
  (deps.fs ?? fs).mkdirSync(installedDir, { recursive: true });
  (deps.fs ?? fs).copyFileSync(sourceHidden, installedHidden);
  registerHourlyTask(TASK, path.join(repo, 'tools', 'mail-stale-draft.mjs'), { ...opts, spawnImpl: deps.spawnImpl });
  console.log(`OK: ${TASK} registered (hourly)`);
  return true;
}
if (isEntry(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
