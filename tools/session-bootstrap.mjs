#!/usr/bin/env node
// Project SessionStart supplies the first hook for a new OS user. User settings are per HOME.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

// register-hooks.mjs が既定で選ぶ同期 checkout(selectAnchor と同じ並び)。
export function anchorCandidates(home) {
  return [path.join(home, '.claude', 'nightly-repo'), path.join(home, 'orgiast-claude-rules')];
}

// ORGIAST_REPO を渡すと register-hooks は clean anchor の検査を飛ばしてそのフォルダを登録する。
// worktree や作業用 clone で Claude を起動するたびに全社 hook がそこへ向け直され、
// worktree を消すと全 hook が壊れる(2026-10-17 実測: settings.json の hook 57本が worktree を指した)。
// 同期 checkout が既にある機体では ORGIAST_REPO を渡さず、register-hooks に anchor を選ばせる。
// anchor がまだ無い新規ユーザーだけ、従来どおりこの checkout を登録する。
export function registrationRepo({ home, repo, exists = fs.existsSync }) {
  const own = path.resolve(repo).toLowerCase();
  const anchors = anchorCandidates(home).filter((dir) => exists(path.join(dir, 'tools', 'register-hooks.mjs')));
  if (anchors.length === 0) return repo;
  return anchors.some((dir) => path.resolve(dir).toLowerCase() === own) ? repo : null;
}

export function bootstrapUser({ home = process.env.ORGIAST_HOME || os.homedir(),
  repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), platform = process.platform, run = spawnSync, exists = fs.existsSync } = {}) {
  if (process.env.CLAUDE_CODE_REMOTE === 'true') return { skipped: 'cloud' };
  if (!['win32', 'darwin', 'linux'].includes(platform)) return { skipped: 'platform' };
  const pinned = registrationRepo({ home, repo, exists });
  const env = { ...process.env, ORGIAST_HOME: home };
  if (pinned) env.ORGIAST_REPO = pinned;
  else delete env.ORGIAST_REPO;
  const registration = run(process.execPath, [path.join(repo, 'tools/register-hooks.mjs'), '--hooks-only'],
    { env, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (registration.status !== 0) throw new Error('user hook registration failed');
  // Hooks registered after startup take effect next session, so sync now as well.
  const sync = run(process.execPath, [path.join(repo, 'tools/onboarding-sync.mjs')],
    { env, encoding: 'utf8', windowsHide: true, timeout: 300000 });
  return { registered: true, syncExit: sync.status, pinnedRepo: pinned };
}
if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(bootstrapUser())); }
  catch { console.error('session-bootstrap failed'); process.exitCode = 1; }
}
