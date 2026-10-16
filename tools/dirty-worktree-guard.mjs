import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// git が強制終了されると `.git/index.lock` が残る。残骸があると `git add`(救済)も
// 索引を書き換える `git status` も `File exists.` で失敗し、救済ブランチだけが作られて
// commit はゼロ・worktree は永久に dirty になる。すると register-hooks の selectAnchor が
// 「clean な main / detached HEAD」を見つけられず setup --converge が exit 1 になり、
// hook 登録と allow ルール同期が無言で止まる（2026-10-13〜16 に実際に発生）。
// 稼働中の git が持つ lock はミリ秒〜秒で解放されるため、この閾値を超えて残っているものは
// 死んだプロセスの置き土産とみなす。閾値未満は「稼働中」として絶対に触らない。
export const DEFAULT_STALE_INDEX_LOCK_MS = 5 * 60 * 1000;

export function clearStaleIndexLock(dir, { log = console.error, maxAgeMs = DEFAULT_STALE_INDEX_LOCK_MS } = {}) {
  const lock = path.join(dir, '.git', 'index.lock');
  let stat;
  try { stat = fs.statSync(lock); }
  catch { return false; } // 無いのが正常。何もしない。
  const ageMs = Date.now() - stat.mtimeMs;
  if (ageMs < maxAgeMs) {
    log(`[INDEX_LOCK_ACTIVE] ${dir}: ${lock} は作成から ${Math.round(ageMs / 1000)}s（閾値 ${Math.round(maxAgeMs / 1000)}s 未満）。稼働中とみなし削除しません`);
    return false;
  }
  try {
    fs.rmSync(lock);
    log(`[STALE_INDEX_LOCK_REMOVED] ${dir}: 残骸 ${lock} を削除（作成から ${Math.round(ageMs / 60000)} 分・git プロセス無し）。1つの残骸で救済が恒久停止するのを防ぎます`);
    return true;
  } catch (error) {
    log(`[STALE_INDEX_LOCK_REMOVE_FAILED] ${dir}: ${error.message}`);
    return false;
  }
}

// A blocked directory stays blocked for the whole invocation, even after rescue.
export function createDirtyWorktreeGuard({
  home = os.homedir(), log = console.error,
  staleIndexLockMs = DEFAULT_STALE_INDEX_LOCK_MS,
  git = (dir, args) => execFileSync('git', ['-C', dir, ...args], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
  }),
} = {}) {
  const blocked = new Set();
  return function allowUpdate(dir) {
    const key = path.resolve(dir);
    if (blocked.has(key)) return false;
    // index.lock を理由に失敗した git コマンドだけ、残骸を回収して1回だけ再試行する。
    // lock を消すのは「実際に邪魔された」かつ「閾値より古い」ときだけなので、稼働中の
    // git を壊す経路は開かない。
    const gitRetryingStaleLock = (args) => {
      try { return git(dir, args); }
      catch (error) {
        if (!/index\.lock/.test(String(error.message))) throw error;
        if (!clearStaleIndexLock(dir, { log, maxAgeMs: staleIndexLockMs })) throw error;
        return git(dir, args);
      }
    };
    let status;
    try { status = gitRetryingStaleLock(['status', '--porcelain', '--untracked-files=all']); }
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
      gitRetryingStaleLock(['switch', '-c', branch]);
      gitRetryingStaleLock(['add', '-A']);
      gitRetryingStaleLock(['-c', 'user.name=Auto Session Rescue', '-c', 'user.email=auto-session-rescue@localhost',
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
