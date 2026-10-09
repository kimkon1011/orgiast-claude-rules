// Called under nightly-bootstrap's per-repository mutex. Never updates/reset the tree.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { notifyKim } from './notify-kim.mjs';
import { redactSecrets } from './webhook-health.mjs';

const RETRY_MS = 6 * 60 * 60 * 1000;
function git(tree, args, input) {
  const r = spawnSync('git', ['-C', tree, ...args], { input, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
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
export function dirtyStatus(tree) {
  const records = git(tree, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all']).split('\0');
  const kept = [], paths = [];
  for (let i = 0; i < records.length; i++) {
    const entry = records[i];
    if (!entry) continue;
    const name = entry.slice(3);
    const from = /[RC]/.test(entry.slice(0, 2)) ? records[++i] : null;
    const nested = entry.startsWith('?? ') && nestedRoot(tree, name);
    if (name === 'scratch' || name.startsWith('scratch/') || nested) continue;
    kept.push(entry + (from == null ? '' : `\0${from}`));
    // Already-staged deletions no longer exist in the index; re-adding them fails.
    if (entry.slice(0, 2) !== 'D ') paths.push(name);
  }
  const text = kept.sort().join('\0');
  return { clean: kept.length === 0, hash: createHash('sha256').update(text).digest('hex'), paths: [...new Set(paths)] };
}

export async function rescueTree(tree, home, { now = Date.now(), notify = notifyKim } = {}) {
  const events = [];
  const log = (step, message) => events.push({ step, message });
  const dir = path.join(home, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'nightly-rescue-state.json');
  // Different repository mutexes can share this state file. Fail closed on contention.
  const lock = `${file}.lock`;
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch {
    log('DIRTY_WORKTREE_SKIP', 'rescue state locked; tree preserved');
    return { clean: false, events };
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
        const result = await notify(message, { home });
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
      if (Math.max(oldFailures, recent) >= 3) await sendOnce(`loop:${hour}`, 'nightly-bootstrap: 1時間内に RESCUE_FAILED が3回以上発生。状態を保持し再試行を抑制しています。');
    };
    await checkLoop();
    const status = dirtyStatus(tree);
    if (status.clean) return { clean: true, events };
    log('DIRTY_WORKTREE_SKIP', `uncommitted changes: ${tree}`);
    const key = path.resolve(tree);
    const attempts = state.attempts[key] ||= {};
    const last = attempts[status.hash];
    if (last != null && now - last < RETRY_MS) {
      log('RESCUE_THROTTLED', 'same dirty status; retry after six hours');
      return { clean: false, events };
    }
    // Keep all recent fingerprints, not only the last: staging/unstaging must not bypass the limit.
    for (const [hash, time] of Object.entries(attempts)) if (now - time >= RETRY_MS) delete attempts[hash];
    attempts[status.hash] = now;
    save();
    const stamp = `${day.replaceAll('-', '')}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
    const base = `rescue/auto-session-${stamp}`;
    const branches = new Set(git(tree, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).trim().split('\n'));
    let branch = base, n = 0;
    while (branches.has(branch)) branch = `${base}-${++n}`;
    try {
      git(tree, ['switch', '-c', branch]);
      // Explicit, NUL-delimited literal paths avoid Git treating ignored exclude
      // pathspecs as errors, and cannot sweep up a clone created after status.
      if (status.paths.length) git(tree, ['add', '-A', '--pathspec-from-file=-', '--pathspec-file-nul'],
        status.paths.map(p => `:(top,literal)${p}\0`).join(''));
      git(tree, ['-c', 'user.name=Auto Session Rescue', '-c', 'user.email=auto-session-rescue@localhost', 'commit', '-m', `auto-session-rescue-${stamp}`]);
      const sha = git(tree, ['rev-parse', 'HEAD']).trim();
      log('RESCUE_LOCAL_OK', `${tree} ${branch} ${sha}`);
      try { fs.appendFileSync(path.join(dir, 'next-session.md'), `\n- [ ] rescue ブランチ ${branch} に退避した変更のレビューが必要（${tree}; ${sha}）\n`); }
      catch (e) { log('RESCUE_HANDOFF_FAILED', e.message); }
      try { git(tree, ['push', '-u', 'origin', branch]); }
      catch { log('RESCUE_PUSH_FAILED_LOCAL_SAVED', branch); }
      await sendOnce(`rescue:${day}`, `nightly-bootstrap: 変更を ${branch} に退避しました。レビューが必要です。`);
    } catch (e) {
      log('RESCUE_FAILED', e.message);
      state.failures = state.failures.filter(t => t > now - 3600000);
      state.failures.push(now);
      // git add can change XY status even though the underlying dirty content did not change.
      try { attempts[dirtyStatus(tree).hash] = now; } catch { /* original fingerprint still guards retries */ }
      save();
      await checkLoop();
    }
    return { clean: false, events };
  } catch (e) {
    log('DIRTY_WORKTREE_SKIP', redactSecrets(e.message));
    return { clean: false, events };
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(lock);
  }
}

if (isEntry(import.meta.url)) {
  const [tree, home] = process.argv.slice(2);
  if (!tree || !home) process.exitCode = 1;
  else console.log(JSON.stringify(await rescueTree(tree, home)));
}
