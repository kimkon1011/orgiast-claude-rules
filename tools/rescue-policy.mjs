// Shared rescue state, exclusions and retry policy for nightly and hourly sync.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { notifyKim } from './notify-kim.mjs';
import { listItems } from './kim-inbox.mjs';
import { redactSecrets } from './webhook-health.mjs';

import { formatKimNotice } from './lib/kim-notice.mjs';
import { clearStaleIndexLock } from './dirty-worktree-guard.mjs';

const RETRY_MS = 6 * 60 * 60 * 1000;
const RESCUE_REVIEW_KEY = 'rescue-branch-review';
export const WORK_DIRECTORY_EXCLUDES = ['scratch/', '.work/', '.work-*/', '.fleet-mail-work/'];
const excluded = name => WORK_DIRECTORY_EXCLUDES.some(pattern => {
  const root = name.split('/')[0];
  const directory = pattern.slice(0, -1);
  return directory.endsWith('*') ? root.startsWith(directory.slice(0, -1)) : root === directory;
});

function git(tree, args, input, env = process.env) {
  const r = spawnSync('git', ['-C', tree, ...args], { input, env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) {
    const first = (r.stderr || r.error?.message || `exit ${r.status}`).trim().split(/\r?\n/)[0];
    throw new Error(`${args[0]}: ${redactSecrets(first)}`);
  }
  return r.stdout;
}
function nestedRoot(tree, name) {
  const parts = name.replace(/\/$/, '').split('/');
  for (let i = 1; i <= parts.length; i++) {
    const prefix = parts.slice(0, i).join('/');
    if (fs.existsSync(path.join(tree, prefix, '.git'))) return prefix;
  }
  return null;
}
// `status` と `git add` の間に作られた入れ子クローンは gitlink (mode 160000) として
// index に入る。宣言済み submodule ではない gitlink が rescue コミットに入ると、その
// ブランチの checkout が以後すべて壊れる（2026-11-17 rescue/auto-session-20261117-153005）。
// staging 後の index を実測して落とす後段ガード。
export function unstageUndeclaredGitlinks(tree, env = process.env) {
  const stagedLinks = git(tree, ['ls-files', '--stage'], undefined, env)
    .split(/\r?\n/).filter(Boolean)
    .filter(line => line.startsWith('160000 '))
    .map(line => line.slice(line.indexOf('\t') + 1));
  if (!stagedLinks.length) return [];
  // HEAD に既にある gitlink は正規の submodule。落とすのは新規に入った分だけ。
  const known = new Set(git(tree, ['ls-tree', '-r', 'HEAD'], undefined, env)
    .split(/\r?\n/).filter(line => line.startsWith('160000 '))
    .map(line => line.slice(line.indexOf('\t') + 1)));
  const drop = stagedLinks.filter(p => !known.has(p));
  if (drop.length) git(tree, ['rm', '--cached', '-f', '-q', '--', ...drop], undefined, env);
  return drop;
}
export function dirtyStatus(tree) {
  const records = git(tree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']).split('\0');
  const kept = [], paths = [], snapshotPaths = [];
  for (let i = 0; i < records.length; i++) {
    const entry = records[i];
    if (!entry) continue;
    const name = entry.slice(3);
    const from = /[RC]/.test(entry.slice(0, 2)) ? records[++i] : null;
    const nested = entry.startsWith('?? ') && nestedRoot(tree, name);
    if (excluded(name) || nested) continue;
    snapshotPaths.push(name);
    if (from && !excluded(from)) snapshotPaths.push(from);
    kept.push(entry + (from == null ? '' : `\0${from}`));
    // Already-staged deletions no longer exist in the index; re-adding them fails.
    if (entry.slice(0, 2) !== 'D ') paths.push(name);
  }
  const text = kept.sort().join('\0');
  return { clean: kept.length === 0, count: kept.length, snapshotPaths: [...new Set(snapshotPaths)], hash: createHash('sha256').update(text).digest('hex'), paths: [...new Set(paths)] };
}

// A repeated rescue of unchanged dirty content rewrites the same tree under a new
// timestamp. The tree SHA — not the commit SHA — identifies the snapshot, so an
// existing rescue branch with the same tree already preserves these changes.
function rescuedTrees(tree) {
  // %(tree) resolves each ref's tree in one process. A rev-parse fan-out with one
  // `<sha>^{tree}` argument per ref exceeds the Windows command-line length limit
  // once hundreds of rescue/* refs accumulate, and RESCUE_FAILED ENAMETOOLONG
  // blocks every rescue after that (observed with 700 refs on 2026-10-16).
  const refs = git(tree, ['for-each-ref', '--format=%(tree) %(refname:short)',
    'refs/heads/rescue/', 'refs/remotes/origin/rescue/']).split(/\r?\n/).filter(Boolean);
  const byTree = refs.map(line => { const i = line.indexOf(' '); return [line.slice(0, i), line.slice(i + 1).trim()]; });
  return new Map(byTree.filter(([t]) => t));
}

// A rescue whose diff against origin/main adds no line holds nothing main lacks,
// even when its blobs never landed verbatim (a locally edited copy of a file main
// has since improved). numstat counts added lines per path; binary paths report
// "-" and are treated as unknown.
function mainIsSuperset(tree, sha, paths) {
  let rows;
  // Without a pathspec this compares whole trees, so main's own newer work on
  // untouched files counts as added lines and hides a genuinely stale rescue
  // (measured on 9ed741f0, 2026-11-20).
  try { rows = git(tree, ['diff', '--numstat', 'origin/main', sha, '--', ...paths]).split(/\r?\n/).filter(Boolean); }
  catch { return false; }
  if (!rows.length) return false;
  return rows.every(row => row.split('\t')[0] === '0');
}

// A rescue branch whose every changed path already exists verbatim somewhere in
// origin/main's history is a stale copy of work that already landed. Flagging it
// in the handoff stops the reviewer from re-reading the same superseded diff every
// night. Deleting the branch stays a human decision, so this only annotates.
export function supersededByMain(tree, sha, { limit = 50 } = {}) {
  let changed;
  try {
    changed = git(tree, ['diff-tree', '--no-commit-id', '--name-only', '-r', sha]).split(/\r?\n/).filter(Boolean);
  } catch { return false; }
  if (!changed.length) return false;
  if (mainIsSuperset(tree, sha, changed)) return true;
  for (const file of changed) {
    let blob;
    // A path the rescue commit deleted has no blob to match; treat it as unseen.
    try { blob = git(tree, ['rev-parse', `${sha}:${file}`]).trim(); } catch { return false; }
    let history;
    try {
      history = git(tree, ['rev-list', '-n', String(limit), 'origin/main', '--', file]).split(/\r?\n/).filter(Boolean);
    } catch { return false; }
    const landed = history.some(commit => {
      try { return git(tree, ['rev-parse', `${commit}:${file}`]).trim() === blob; } catch { return false; }
    });
    if (!landed) return false;
  }
  return true;
}

export function snapshotTree(tree, status) {
  // A private index snapshots changes without changing HEAD, the real index or files.
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-rescue-index-'));
  try {
    const env = { ...process.env, GIT_INDEX_FILE: path.join(temp, 'index') };
    const parent = git(tree, ['rev-parse', 'HEAD']).trim();
    git(tree, ['read-tree', parent], undefined, env);
    if (status.snapshotPaths.length) git(tree, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
      status.snapshotPaths.map(p => `:(top,literal)${p}\0`).join(''), env);
    unstageUndeclaredGitlinks(tree, env);
    return git(tree, ['write-tree'], undefined, env).trim();
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function snapshotRescue(tree, status, branch, stamp, log) {
  const parent = git(tree, ['rev-parse', 'HEAD']).trim();
  const snapshot = snapshotTree(tree, status);
  const alreadyRescued = rescuedTrees(tree).get(snapshot);
  if (alreadyRescued) {
    log('RESCUE_DUPLICATE', `${tree} snapshot already rescued as ${alreadyRescued}`);
    return { sha: null, branch: alreadyRescued };
  }
  const sha = git(tree, ['-c', 'user.name=Auto Session Rescue', '-c', 'user.email=auto-session-rescue@localhost',
    'commit-tree', snapshot, '-p', parent, '-m', `sync-orgiast-main-rescue-${stamp}`]).trim();
  git(tree, ['update-ref', `refs/heads/${branch}`, sha, '0000000000000000000000000000000000000000']);
  return { sha, branch };
}

export async function rescueTree(tree, home, { now = Date.now(), notify = notifyKim, preserveTree = false, pc = os.hostname() } = {}) {
  const events = [];
  let dirtyCount;
  const log = (step, message) => events.push({ step, message });
  // 5分より古い index.lock は落ちた git の残骸。消さないと毎晩「専用indexで保全」だけを繰り返し、
  // 作業ツリーが main に戻れない（2026-10-21〜23 DESKTOP-PPD5V8I で2日停止）。新しいロックは残す。
  clearStaleIndexLock(tree, { log: message => log('STALE_INDEX_LOCK', message) });
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'nightly-rescue-state.json');
  // Different repository mutexes can share this state file. Fail closed on contention.
  const lock = `${file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch {
    log('DIRTY_WORKTREE_SKIP', 'rescue state locked; tree preserved');
    return { clean: false, dirtyCount, events };
  }
  try {
    let state = { attempts: {}, notifications: {}, failures: [] };
    if (fs.existsSync(file)) state = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!state.attempts || !state.notifications || !Array.isArray(state.failures)) throw new Error('invalid rescue state; tree preserved');
    const save = () => {
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(state, null, 2));
      fs.renameSync(temp, file);
    };
    const date = new Date(now);
    const pad = n => String(n).padStart(2, '0');
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const hour = `${day}-${pad(date.getHours())}`;
    const sendOnce = async (key, message) => {
      if (state.notifications[key]) return;
      state.notifications[key] = now; // Record before sending; uncertain delivery must not duplicate a DM.
      save();
      try {
        const result = await notify(message, { home, ...(preserveTree ? { webhookFallback: false } : {}) });
        if (result?.delivered === 'none') log('RESCUE_NOTIFY_FAILED', 'notify-kim did not deliver');
      } catch (e) { log('RESCUE_NOTIFY_FAILED', redactSecrets(e.message)); }
    };
    const checkLoop = async () => {
      const logFile = path.join(dir, 'logs', `nightly-bootstrap-${day}.log`);
      let oldFailures = 0;
      if (fs.existsSync(logFile)) {
        const prefix = `${day} ${pad(date.getHours())}:`;
        oldFailures = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(line => line.startsWith(prefix) && / \/ RESCUE_FAILED \/ /.test(line)).length;
      }
      const recent = state.failures.filter(t => t > now - 3600000 && t <= now).length;
      if (Math.max(oldFailures, recent) >= 3) await sendOnce(`loop:${hour}`, formatKimNotice({ what: `夜間の自動復旧が 1 時間に 3 回失敗しました。\n原因: ${state.lastFailure || '過去ログの RESCUE_FAILED（詳細調査を起票）'}`, next: '明日の夜間バッチで自動的にやり直します', kim: 'なし' }));
    };
    if (!preserveTree) await checkLoop();
    const status = dirtyStatus(tree);
    dirtyCount = status.count;
    const key = path.resolve(tree);
    state.dirtySince ||= {};
    if (status.clean) {
      if (key in state.dirtySince) { delete state.dirtySince[key]; save(); }
      return { clean: true, dirtyCount, events };
    }
    if (preserveTree) {
      state.dirtySince[key] ??= now;
      save();
      if (now - state.dirtySince[key] >= 24 * 3600000) {
        await sendOnce(`dirty:${key}:${day}`, `PC: ${pc}\nTree: ${tree}\nDirty paths: ${status.count}`);
      }
    }
    log('DIRTY_WORKTREE_SKIP', `uncommitted changes: ${tree}`);
    const attempts = state.attempts[key] ||= {};
    const last = attempts[status.hash];
    if (last != null && now - last < RETRY_MS) {
      log('RESCUE_THROTTLED', 'same dirty status; retry after six hours');
      return { clean: false, dirtyCount, events };
    }
    // Keep all recent fingerprints, not only the last: staging/unstaging must not bypass the limit.
    for (const [hash, time] of Object.entries(attempts)) if (now - time >= RETRY_MS) delete attempts[hash];
    attempts[status.hash] = now;
    save();
    const stamp = `${day.replaceAll('-', '')}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    const base = `rescue/${preserveTree ? 'sync-orgiast-main' : 'auto-session'}-${stamp}`;
    const branches = new Set(git(tree, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).trim().split('\n'));
    let branch = base, n = 0;
    while (branches.has(branch)) branch = `${base}-${++n}`;
    try {
      let sha;
      if (preserveTree) {
        ({ sha } = snapshotRescue(tree, status, branch, stamp, log));
        if (!sha) return { clean: false, dirtyCount, events };
      } else {
        const snapshot = snapshotTree(tree, status);
        const already = rescuedTrees(tree).get(snapshot);
        if (already) {
          log('RESCUE_DUPLICATE', `${tree} snapshot already rescued as ${already}`);
          return { clean: false, dirtyCount, events };
        }
        git(tree, ['switch', '-c', branch]);
        // Explicit, NUL-delimited literal paths avoid Git treating ignored exclude
        // pathspecs as errors, and cannot sweep up a clone created after status.
        if (status.paths.length) git(tree, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
          status.paths.map(p => `:(top,literal)${p}\0`).join(''));
        const droppedLinks = unstageUndeclaredGitlinks(tree);
        if (droppedLinks.length) log('RESCUE_GITLINK_DROPPED', droppedLinks.join(' '));
        git(tree, ['-c', 'user.name=Auto Session Rescue', '-c', 'user.email=auto-session-rescue@localhost', 'commit', '-m', `auto-session-rescue-${stamp}`]);
        sha = git(tree, ['rev-parse', 'HEAD']).trim();
      }
      log('RESCUE_LOCAL_OK', `${tree} ${branch} ${sha}`);
      let landedNote = '';
      try { if (supersededByMain(tree, sha)) landedNote = '（判定: 変更内容はすべて origin/main の履歴に存在。着地済みの可能性が高い）'; }
      catch { /* annotation only; a failed probe must not block the handoff line */ }
      try { fs.appendFileSync(path.join(dir, 'next-session.md'), `\n- [ ] rescue ブランチ ${branch} に退避した変更のレビューが必要（${tree}; ${sha}）${landedNote}\n`); }
      catch (e) { log('RESCUE_HANDOFF_FAILED', e.message); }
      try { git(tree, ['push', '-u', 'origin', branch]); }
      catch { log('RESCUE_PUSH_FAILED_LOCAL_SAVED', branch); }
      if (!preserveTree) {
        const existing = listItems(home).find(item => item.dedupeKey === RESCUE_REVIEW_KEY);
        const known = String(existing?.text || '').match(/rescue\/auto-session-\d{8}-\d{6}(?:-\d+)?/g) || [];
        state.rescueBranches = [...new Set([...(state.rescueBranches || []), ...known, branch])].sort();
        state.rescueCount = (state.rescueCount ?? existing?.count ?? existing?.repeatCount ?? 0) + 1;
        save();
        const all = state.rescueBranches;
        const message = `rescue ブランチのレビュー・削除承認待ち（最新: ${branch} ／ 計 ${all.length} 件）\n対象ブランチ:\n${all.map(name => `- ${name}`).join('\n')}`;
        await notify(message, { home, kind: 'ask', kimActionRequired: true, source: 'nightly-bootstrap', dedupeKey: RESCUE_REVIEW_KEY, replaceExisting: true, incrementExisting: true, plainJa: false });
      }
    } catch (e) {
      // A shared index lock (or a timed-out commit hook) must not prevent a
      // snapshot. Preserve the real index/HEAD and commit with a private index.
      if (/index\.lock|ETIMEDOUT/.test(e.message)) {
        try {
          const snapshot = snapshotRescue(tree, status, `${branch}-snapshot`, stamp, log);
          log('RESCUE_LOCAL_OK', `private index: ${snapshot.branch}`);
          fs.appendFileSync(path.join(dir, 'next-session.md'), `\n- [ ] rescue 修復: ${tree}: ${redactSecrets(e.message)}。変更は ${snapshot.branch} に保全済み。共有Git操作を調査し再検証する。\n`);
          await sendOnce(`index:${day}`, `夜間の自動復旧: 変更を保全しました。\n原因: ${redactSecrets(e.message)}\n対処: 専用インデックスで退避し、next-session.md に共有Git操作の調査を起票しました。`);
          return { clean: false, dirtyCount, events };
        } catch (repairError) { log('RESCUE_REPAIR_FAILED', redactSecrets(repairError.message)); }
      }
      log('RESCUE_FAILED', e.message);
      state.lastFailure = redactSecrets(e.message);
      state.failures = state.failures.filter(t => t > now - 3600000);
      state.failures.push(now);
      // git add can change XY status even though the underlying dirty content did not change.
      try { attempts[dirtyStatus(tree).hash] = now; } catch { /* original fingerprint still guards retries */ }
      save();
      if (!preserveTree) await checkLoop();
    }
    return { clean: false, dirtyCount, events };
  } catch (e) {
    log('DIRTY_WORKTREE_SKIP', redactSecrets(e.message));
    return { clean: false, dirtyCount, events };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

