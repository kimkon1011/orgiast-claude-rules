#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawnSync as defaultSpawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

export function directiveId(kind, date = new Date(), randomInt = (max) => crypto.randomInt(max)) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${kind}-${stamp}-${String(randomInt(10_000)).padStart(4, '0')}`;
}

function valueAfter(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

export function pruneDirectives(directives, now = Date.now()) {
  return directives.filter((item) => !item.processed && !item.processedAt && (!item.expiresAt || Date.parse(item.expiresAt) >= now));
}

function git(dir, args, spawnSync = defaultSpawnSync) {
  const result = spawnSync('git', args, {
    cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true, encoding: 'utf8', timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    const error = new Error(String(result.stderr || result.error?.message || result.stdout || 'git failed').trim().split(/\r?\n/)[0]);
    error.nonFastForward = /non-fast-forward|fetch first|stale info/i.test(`${result.stderr || ''} ${result.stdout || ''}`);
    throw error;
  }
  return (result.stdout || '').trim();
}

export function resolvePushRepo({ repo, home = os.homedir(), spawnSync = defaultSpawnSync, cloneUrl } = {}) {
  try {
    if (git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], spawnSync) === 'main'
      && git(repo, ['rev-parse', '--is-inside-work-tree'], spawnSync) === 'true') {
      return { dir: repo, dedicated: false };
    }
  } catch { /* detached HEAD or a non-git directory */ }
  const dir = path.join(home, '.claude', 'fleet-directives-repo');
  try {
    if (!fs.existsSync(dir)) {
      if (!cloneUrl) {
        try { cloneUrl = git(repo, ['remote', 'get-url', 'origin'], spawnSync); } catch { /* use default */ }
      }
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      git(path.dirname(dir), ['clone', '--branch', 'main', '--single-branch', cloneUrl || 'https://github.com/kimkon1011/orgiast-claude-rules.git', dir], spawnSync);
    } else {
      // This clone is exclusively for directive delivery. Never use it for other work:
      // abandoned local commits and files are deliberately discarded on each send.
      git(dir, ['fetch', 'origin', 'main'], spawnSync);
      git(dir, ['checkout', '-B', 'main', 'origin/main'], spawnSync);
      git(dir, ['reset', '--hard', 'origin/main'], spawnSync);
      git(dir, ['clean', '-fd'], spawnSync);
    }
  } catch (error) {
    try {
      if (fs.existsSync(dir)) {
        git(dir, ['reset', '--hard', 'origin/main'], spawnSync);
        git(dir, ['clean', '-fd'], spawnSync);
      }
    } catch (cleanupError) {
      error.message += ` (cleanup failed: ${cleanupError.message})`;
    }
    throw new Error(`fleet-directive-send: push failed: ${error.message}`);
  }
  return { dir, dedicated: true };
}

export function main(argv = process.argv.slice(2), options = {}) {
  const repo = options.repo || path.resolve(import.meta.dirname, '..');
  const push = argv.includes('--push');
  const spawnSync = options.spawnSync || defaultSpawnSync;
  const pruneOnly = argv.includes('--prune') && !valueAfter(argv, '--kind');
  const writeDirective = (dir, directive) => {
    const file = path.join(dir, 'fleet-directives.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    parsed.directives = pruneDirectives(Array.isArray(parsed.directives) ? parsed.directives : []);
    if (directive && !parsed.directives.some(item => item.id === directive.id)) parsed.directives.push(directive);
    fs.writeFileSync(file, `${JSON.stringify(parsed, null, 2)}\n`);
  };
  if (pruneOnly && !push) {
    writeDirective(repo);
    return { pruned: true };
  }
  const kind = valueAfter(argv, '--kind');
  const targets = valueAfter(argv, '--targets') ?? 'all';
  const why = valueAfter(argv, '--why');
  if (!pruneOnly && !why) throw new Error('--why は必須です（遠隔指示の理由を指定してください）');
  if (!pruneOnly && !['status', 'prompt', 'enable-auto-session', 'run'].includes(kind)) throw new Error('--kind は status / prompt / enable-auto-session / run のいずれかです');
  const task = valueAfter(argv, '--task');
  if (kind === 'run' && !['fleet-sheet-report', 'cost-self-heal'].includes(task)) throw new Error('run の --task は fleet-sheet-report / cost-self-heal のいずれかです');
  const bodyFile = valueAfter(argv, '--body-file');
  if (kind === 'prompt' && !bodyFile) throw new Error('prompt は --body-file で本文ファイルを指定してください');
  const createdAt = new Date();
  const directive = { id: directiveId(kind, createdAt, options.randomInt), kind, targets, why };
  if (kind === 'run') directive.task = task;
  if (bodyFile) directive.body = fs.readFileSync(path.resolve(bodyFile), 'utf8').replace(/^\uFEFF/, '');
  const cwd = valueAfter(argv, '--cwd');
  if (cwd) directive.cwd = cwd;
  directive.createdBy = valueAfter(argv, '--created-by') || process.env.USER || process.env.USERNAME || 'unknown';
  directive.createdAt = createdAt.toISOString();
  const expiresHours = Number(valueAfter(argv, '--expires-hours'));
  if (Number.isFinite(expiresHours) && expiresHours > 0) directive.expiresAt = new Date(createdAt.getTime() + expiresHours * 3_600_000).toISOString();
  const timeoutSeconds = Number(valueAfter(argv, '--timeout-seconds'));
  if (Number.isFinite(timeoutSeconds) && timeoutSeconds > 0) directive.timeoutSeconds = timeoutSeconds;
  if (!push) {
    writeDirective(repo, directive);
  } else {
    const { dir, dedicated } = resolvePushRepo({ repo, home: options.home, cloneUrl: options.cloneUrl, spawnSync });
    const run = args => git(dir, args, spawnSync);
    const commit = () => {
      writeDirective(dir, pruneOnly ? undefined : directive);
      run(['add', 'fleet-directives.json']);
      run(['-c', 'user.name=Fleet Directive', '-c', 'user.email=fleet-directive@localhost',
        'commit', '--only', '-m', pruneOnly ? 'fleet: prune directives' : `fleet: add directive ${directive.id}`, '--', 'fleet-directives.json']);
    };
    try {
      commit();
      try {
        run(['push', 'origin', 'HEAD:main']);
      } catch (error) {
        if (!error.nonFastForward) throw error;
        run(['fetch', 'origin', 'main']);
        if (dedicated) {
          run(['reset', '--hard', 'origin/main']);
          commit();
        } else {
          // A caller-owned main tree may contain unrelated staged/unstaged work.
          // Save it before resetting to the remote, then restore its index state.
          const dirty = run(['status', '--porcelain']);
          if (dirty) run(['stash', 'push', '--include-untracked', '-m', 'fleet-directive-send retry']);
          try {
            run(['reset', '--hard', 'origin/main']);
            commit();
          } finally {
            if (dirty) run(['stash', 'pop', '--index']);
          }
        }
        run(['push', 'origin', 'HEAD:main']);
      }
    } catch (error) {
      try {
        if (dedicated) {
          run(['reset', '--hard', 'origin/main']);
          run(['clean', '-fd']);
        } else {
          run(['checkout', 'HEAD', '--', 'fleet-directives.json']);
        }
      } catch (cleanupError) {
        error.message += ` (cleanup failed: ${cleanupError.message})`;
      }
      throw new Error(`fleet-directive-send: push failed: ${error.message}`);
    }
  }
  if (pruneOnly) return { pruned: true };
  console.log(directive.id);
  return directive;
}

if (isEntry(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
