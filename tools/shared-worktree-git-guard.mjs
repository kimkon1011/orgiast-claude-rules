#!/usr/bin/env node
export const GATE_CONTRACT = {"name": "shared-worktree-git-guard", "remedies": [{"kind": "repo-file", "ref": "tools/gate-remedies.md", "section": "shared-worktree-git-guard"}]};

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

const separators = /^(?:&&|\|\||[;&|\n])$/;
const commitValueOptions = new Set([
  '--message', '--file', '--author', '--date', '--template', '--cleanup',
  '--reuse-message', '--reedit-message', '--fixup', '--squash', '--trailer',
  '--pathspec-from-file',
]);

// Keep shell separators inside quotes as arguments and preserve Windows paths.
function* segments(command) {
  const tokens = /&&|\|\||[;&|\n]|#[^\n]*|(?:'(?:[^']|'')*'|"(?:[^"\\]|\\[\\"]|\\(?![\\"]))*"|[^\s;&|'"<>])+|\d*(?:>>?|<)[&]?/g;
  let args = [];
  for (const [token] of command.matchAll(tokens)) {
    if (separators.test(token)) {
      if (args.length) yield { args, separator: token };
      args = [];
    } else if (!token.startsWith('#')) {
      args.push(token);
    }
  }
  if (args.length) yield { args, separator: '' };
}

function unquote(token) {
  return token.replace(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g, (_, single, double) => single ?? double.replace(/\\(["\\])/g, '$1'));
}

function commitViolation(args) {
  let hasPath = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      hasPath ||= i + 1 < args.length;
      break;
    }
    if (arg === '--all') return 'commit-all';
    if (arg.startsWith('--')) {
      if (arg === '--pathspec-from-file' || arg.startsWith('--pathspec-from-file=')) {
        hasPath ||= arg.includes('=') ? arg.split('=')[1] !== '' : Boolean(args[i + 1]);
      }
      if (commitValueOptions.has(arg)) i++;
    } else if (arg.startsWith('-') && arg !== '-') {
      for (let j = 1; j < arg.length; j++) {
        const option = arg[j];
        if (option === 'a') return 'commit-all';
        if ('mFCct'.includes(option)) {
          if (j === arg.length - 1) i++;
          break;
        }
        // -S takes an optional key only when attached.
        if (option === 'S') break;
      }
    } else {
      hasPath = true;
    }
  }
  return hasPath ? null : 'commit-no-pathspec';
}

function gitViolation(args) {
  const [subcommand, ...options] = args;
  if (subcommand === 'add') {
    for (const arg of options.slice(0, options.indexOf('--') < 0 ? options.length : options.indexOf('--'))) {
      if (/^--(?:all|update)$/.test(arg) || /^-[^-]*[Au]/.test(arg)) return 'add-all';
    }
    if (options.some(arg => /^(?:\.[\\/])*\.(?:[\\/])?$/.test(arg))) return 'add-all';
  }
  if (subcommand === 'commit') return commitViolation(options);
  if (subcommand === 'stash' && !['list', 'show'].includes(options[0])) return 'stash';
  return null;
}

function* violations(command) {
  let directories = [];
  let piped = false;
  for (const { args: raw, separator } of segments(command)) {
    const args = [];
    for (let i = 0; i < raw.length; i++) {
      if (/^\d*[<>]/.test(raw[i])) i++;
      else args.push(unquote(raw[i]));
    }
    if (args[0] === '&') args.shift();
    if (!piped && separator !== '|' && /^(?:cd|set-location)$/i.test(args[0]) && args.length === 2) {
      directories = [...directories, args[1]];
    }
    if (/^(?:.*[\\/])?git(?:\.exe)?$/i.test(args[0])) {
      const target = [...directories];
      let index = 1;
      while (args[index]?.startsWith('-')) {
        const option = args[index++];
        if (option === '-C') {
          if (args[index]) target.push(args[index]);
          index++;
        } else if (option === '-c' || option === '--config-env') {
          index++;
        }
      }
      const violation = gitViolation(args.slice(index));
      if (violation) yield { violation, directories: target };
    }
    piped = separator === '|';
  }
}

export function classifyGitCommand(command) {
  return { violation: violations(command).next().value?.violation ?? null };
}

const gitTimeout = 1_000;

function runGit(cwd, args, deadline) {
  const timeout = Math.min(gitTimeout, deadline - Date.now());
  if (timeout <= 0) return null;
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout, windowsHide: true });
  return result.status === 0 ? result.stdout.trim() : null;
}

function resolveDirectory(cwd, directory) {
  const expanded = directory.replace(/^~(?=[\\/]|$)/, homedir());
  return path.resolve(cwd, expanded);
}

function canonical(directory) {
  const real = fs.realpathSync.native(directory);
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function isSharedTree(cwd, deadline, cache) {
  const toplevel = runGit(cwd, ['rev-parse', '--show-toplevel'], deadline);
  if (!toplevel || !fs.statSync(path.join(toplevel, '.git')).isDirectory()) return false;
  const root = canonical(toplevel);
  if (cache.has(root)) return cache.get(root);

  const listed = [
    ...['Downloads/orgiast-claude-rules', 'orgiast-claude-rules', '.claude/nightly-repo', 'Downloads/ブース制作アプリ']
      .map(directory => path.join(homedir(), directory)),
    ...(process.env.ORGIAST_SHARED_WORKTREES ?? '').split(';').filter(Boolean),
  ].some(directory => {
    try { return canonical(resolveDirectory(cwd, directory)) === root; }
    catch { return false; }
  });
  const worktrees = listed ? null : runGit(toplevel, ['worktree', 'list', '--porcelain'], deadline);
  const shared = listed || (worktrees?.match(/^worktree /gm)?.length ?? 0) >= 2;
  cache.set(root, shared);
  return shared;
}

const reason = [
  '共有作業ツリーで他セッションの変更を巻き込む Git 操作を止めました。',
  '自分の変更だけを確定するには `git add <自分のパス>` → `git commit -F <msg> -- <自分のパス>` を使ってください。',
  'stash の代わりに `git worktree add -b <branch> <別dir> origin/main` で専用ツリーを作ってください。',
  'commit 後は `git show --stat --format="" HEAD` でファイル名を確認してください。',
].join('\n');

export async function hookMain(raw) {
  try {
    const input = JSON.parse(raw);
    const command = input.tool_input?.command;
    if (!/^(Bash|PowerShell)$/.test(input.tool_name) || typeof command !== 'string' || !input.cwd) return;
    const deadline = Date.now() + 5_000;
    const cache = new Map();
    for (const { directories } of violations(command)) {
      try {
        const cwd = directories.reduce(resolveDirectory, input.cwd);
        if (!isSharedTree(cwd, deadline, cache)) continue;
      } catch {
        continue;
      }
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: reason,
        },
      }));
      return;
    }
  } catch {}
}

if (isEntry(import.meta.url)) await hookMain(await readStdinWithTimeout());
