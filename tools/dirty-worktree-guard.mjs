import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// A blocked directory stays blocked for the whole invocation, even after rescue.
export function createDirtyWorktreeGuard({
  home = os.homedir(), log = console.error,
  git = (dir, args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  }),
} = {}) {
  const blocked = new Set();
  return function allowUpdate(dir) {
    const key = path.resolve(dir);
    if (blocked.has(key)) return false;
    let status;
    try { status = git(dir, ['status', '--porcelain', '--untracked-files=all']); }
    catch (error) {
      blocked.add(key);
      log(`[DIRTY_WORKTREE_SKIP] ${dir}: status failed: ${error.message}`);
      return false;
    }
    if (!status.trim()) return true;
    blocked.add(key);
    log(`[DIRTY_WORKTREE_SKIP] ${dir}: uncommitted changes; all destructive updates skipped`);
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const base = `rescue/auto-session-${stamp}`;
    let branch = base;
    // Linked worktrees share refs. Never overwrite an existing rescue branch.
    for (let n = 1; ; n++) {
      try { git(dir, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]); }
      catch { break; }
      branch = `${base}-${n}`;
    }
    try {
      git(dir, ['switch', '-c', branch]);
      git(dir, ['add', '-A']);
      git(dir, ['-c', 'user.name=Auto Session Rescue', '-c', 'user.email=auto-session-rescue@localhost',
        'commit', '-m', `auto-session-rescue-${stamp}`]);
      const sha = git(dir, ['rev-parse', 'HEAD']).trim();
      log(`[RESCUE_LOCAL_OK] ${dir}: ${branch} ${sha}`);
      // Write the handoff before attempting the optional network operation.
      try {
        const note = path.join(home, '.claude', 'next-session.md');
        fs.mkdirSync(path.dirname(note), { recursive: true });
        fs.appendFileSync(note, `\n- [ ] rescue ブランチ \`${branch}\` に退避した変更のレビューが必要（${dir}; ${sha}）\n`);
      } catch (error) { log(`[RESCUE_HANDOFF_FAILED] ${branch}: ${error.message}`); }
      try { git(dir, ['push', '-u', 'origin', branch]); }
      catch (error) { log(`[RESCUE_PUSH_FAILED_LOCAL_SAVED] ${branch}: ${error.message}`); }
    } catch (error) {
      // No rollback/reset/clean: preserve the files and any partially staged rescue.
      log(`[RESCUE_FAILED] ${dir}: ${error.message}`);
    }
    return false;
  };
}
