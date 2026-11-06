#!/usr/bin/env node
// Restore the six offline commits after the worktree's Git directory becomes writable.
// Never rewrites working files, pushes, or opens a PR.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
export function restoreDeadlineCommits({ repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), packageDir = path.join(repo, 'reports/deadline-watch-20261105') } = {}) {
  const git = (args, env = {}) => execFileSync('git', args, { cwd: repo, env: { ...process.env, ...env }, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4*1024*1024 }).trim();
  const metadata = JSON.parse(fs.readFileSync(path.join(packageDir, 'commits.json'), 'utf8'));
  for (const id of [metadata.base, metadata.target]) if (!/^[0-9a-f]{40}$/.test(id)) throw new Error('Invalid commit package');
  if (metadata.branch !== 'feat/deadline-watch') throw new Error('Unexpected package branch');
  const head = git(['rev-parse','HEAD']);
  if (head === metadata.target) {
    if (git(['diff','--cached','--name-only'])) throw new Error('Commit restored, but the index has newer staged changes; leave them untouched');
    return { restored: false, reason: 'already-restored', commit: head };
  }
  if (head !== metadata.base || git(['branch','--show-current']) !== metadata.branch) throw new Error('Branch advanced or changed; leave it untouched and review the bundle');
  if (git(['diff','--cached','--name-only'])) throw new Error('Staged changes exist; leave them untouched');
  const bundle = path.join(packageDir, 'deadline-watch.bundle');
  git(['bundle','verify',bundle]);
  git(['fetch','--no-tags',bundle,`refs/heads/${metadata.branch}`]);
  if (git(['rev-parse','FETCH_HEAD']) !== metadata.target) throw new Error('Bundle target mismatch');
  const changes = git(['diff','--name-only',metadata.base,metadata.target]).split('\n').filter(Boolean);
  for (const file of changes) {
    if (!fs.existsSync(path.join(repo,file))) throw new Error(`Missing working file: ${file}`);
    const expected = git(['rev-parse',`${metadata.target}:${file}`]);
    const actual = git(['hash-object',`--path=${file}`,file]);
    if (expected !== actual) throw new Error(`Working file changed after implementation: ${file}`);
  }
  // Hold Git's own index lock and use compare-and-swap for the branch. Another
  // session's staging or newer commit must never be overwritten during restore.
  const index = path.resolve(repo, git(['rev-parse','--git-path','index']));
  const lock = `${index}.lock`;
  fs.closeSync(fs.openSync(lock, 'wx'));
  let advanced = false;
  try {
    if (git(['diff','--cached','--name-only'])) throw new Error('Staged changes appeared during restore');
    fs.copyFileSync(index, lock);
    git(['read-tree',metadata.target], { GIT_INDEX_FILE: lock });
    git(['update-ref',`refs/heads/${metadata.branch}`,metadata.target,metadata.base]);
    advanced = true;
    fs.renameSync(lock, index);
    advanced = false;
  } catch (error) {
    if (advanced) {
      try { git(['update-ref',`refs/heads/${metadata.branch}`,metadata.base,metadata.target]); } catch { /* Preserve a concurrent newer ref. */ }
    }
    throw error;
  } finally { fs.rmSync(lock, { force: true }); }
  if (git(['rev-parse','HEAD']) !== metadata.target || git(['diff','--cached','--name-only'])) throw new Error('Restore read-back failed');
  return { restored: true, commit: metadata.target, files: changes.length };
}
if (isEntry(import.meta.url)) {
  try { console.log(JSON.stringify(restoreDeadlineCommits())); }
  catch (e) { console.error(e.message); process.exitCode = 1; }
}
