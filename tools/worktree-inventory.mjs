#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isEntry } from './is-entry.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;
const categories = [
  'keep-main', 'keep-protected', 'keep-repair', 'prune', 'keep-dirty',
  'keep-recent', 'keep-unpushed', 'safe', 'keep-error',
];

function isProtected(worktreePath) {
  const normalized = worktreePath.replaceAll('\\', '/').toLowerCase().replace(/\/+$/, '');
  const segments = normalized.split('/').filter(Boolean);
  const last = segments.at(-1) ?? '';
  const parent = segments.at(-2) ?? '';
  return ['nightly-repo', 'auto-session-repo', 'auto-session-tree']
    .some((name) => last.startsWith(name))
    || (parent === 'downloads' && last.startsWith('orgiast-claude-rules'))
    || /^(?:c:|\/mnt\/c)\/users\/orgiast-main(?:\/|$)/.test(normalized);
}

export function classifyWorktree(info) {
  const result = (category, reason) => ({ category, reason });
  if (info.error) return result('keep-error', `点検に失敗しました（${info.error}）。`);
  if (info.main) return result('keep-main', 'メイン作業ツリーです。');
  if (isProtected(info.path)) return result('keep-protected', '保護対象のパスです。');
  if (info.resolvedPath) {
    return result('keep-repair', 'gitdir が相対パスで Git の表示とずれています。`git worktree repair <実パス>` で直してから再点検してください。');
  }
  if (info.prunable) return result('prune', 'Git が登録を整理可能と判定しています。');
  if (info.exists === false) return result('prune', '作業ツリーのディレクトリが存在しません。');
  if (info.dirty) return result('keep-dirty', '未コミットの変更または未追跡ファイルがあります。');
  if (info.updatedAt != null && info.now - info.updatedAt <= DAY_MS) {
    return result('keep-recent', '直近24時間以内に更新されています。');
  }
  if (info.ancestor === true) return result('safe', '変更がなく、HEAD は origin/main の履歴に含まれています。');
  if (info.branch && info.mergedPr === true) return result('safe', '変更がなく、ブランチのマージ済みPRが確認できました。');
  return result('keep-unpushed', info.branch
    ? 'HEAD が origin/main に含まれず、マージ済みPRも確認できていません。'
    : '切り離された HEAD が origin/main の履歴に含まれていません。');
}

function run(command, args) {
  return execFileSync(command, args, {
    encoding: 'utf8', windowsHide: true, timeout: 15_000,
    maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function git(repo, ...args) {
  return run('git', ['--no-optional-locks', '-C', repo, ...args]);
}

function isGitRepository(repo) {
  try {
    git(repo, 'rev-parse', '--git-dir');
    return true;
  } catch {
    return false;
  }
}

function parseWorktrees(output) {
  return output.split('\0\0').filter(Boolean).map((record, index) => {
    const fields = new Map(record.split('\0').map((field) => {
      const space = field.indexOf(' ');
      return space < 0 ? [field, ''] : [field.slice(0, space), field.slice(space + 1)];
    }));
    return {
      path: fields.get('worktree'),
      head: fields.get('HEAD'),
      branch: fields.get('branch')?.replace(/^refs\/heads\//, ''),
      prunable: fields.has('prunable'),
      main: index === 0,
    };
  });
}

function ifExists(read) {
  try {
    return read();
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
    return undefined;
  }
}

function pathKey(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function resolveWorktreePaths(repo, commonDir, worktrees) {
  const realCommonDir = realpathSync.native(commonDir);
  // Git can report a path calculated using the spelling of the repository alias.
  const repoAlias = path.resolve(repo, path.relative(realpathSync.native(repo), realCommonDir));
  const displayBases = new Set([commonDir, realCommonDir, repoAlias]);
  const adminRoot = path.join(realCommonDir, 'worktrees');
  const candidates = new Map();

  for (const entry of ifExists(() => readdirSync(adminRoot)) ?? []) {
    const adminDir = path.join(adminRoot, entry);
    const gitdir = ifExists(() => readFileSync(path.join(adminDir, 'gitdir'), 'utf8'))?.trimEnd();
    if (!gitdir || path.isAbsolute(gitdir) || path.win32.isAbsolute(gitdir)) continue;
    if (path.basename(gitdir) !== '.git') continue;

    const realAdminDir = ifExists(() => realpathSync.native(adminDir));
    if (!realAdminDir) continue;
    const dotGit = path.resolve(realAdminDir, gitdir);
    if (!ifExists(() => statSync(dotGit).isFile())) continue;
    const backlink = ifExists(() => readFileSync(dotGit, 'utf8'));
    const adminLink = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(backlink ?? '')?.[1];
    if (!adminLink) continue;
    const resolvedPath = ifExists(() => realpathSync.native(path.dirname(dotGit)));
    if (!resolvedPath) continue;
    const linkedAdmin = ifExists(() => realpathSync.native(path.resolve(resolvedPath, adminLink)));
    if (!linkedAdmin || pathKey(linkedAdmin) !== pathKey(realAdminDir)) continue;

    const displayPaths = [...displayBases].map((base) =>
      path.dirname(path.resolve(base, 'worktrees', entry, gitdir)));
    for (const key of new Set(displayPaths.map(pathKey))) {
      // Ambiguous display paths cannot identify a specific registration.
      candidates.set(key, candidates.has(key) ? null : resolvedPath);
    }
  }

  return worktrees.map((worktree) => {
    if (worktree.main) return worktree;
    const resolvedPath = candidates.get(pathKey(worktree.path));
    if (!resolvedPath) return worktree;
    const displayedPath = ifExists(() => realpathSync.native(worktree.path));
    if (displayedPath && pathKey(displayedPath) === pathKey(resolvedPath)) return worktree;
    return { ...worktree, resolvedPath };
  });
}

function latestUpdate(worktreePath) {
  let latest = null;
  for (const entry of readdirSync(worktreePath, { withFileTypes: true })) {
    if (entry.name === '.git' || !entry.isFile()) continue;
    latest = Math.max(latest ?? -Infinity, statSync(path.join(worktreePath, entry.name)).mtimeMs);
  }
  const selector = git(worktreePath, 'reflog', 'show', '-1', '--date=iso-strict', '--format=%gD', 'HEAD').trim();
  if (selector) {
    const timestamp = Date.parse(/@\{([^}]+)\}$/.exec(selector)?.[1]);
    if (!Number.isFinite(timestamp)) throw new Error('HEAD の reflog の日時を読み取れません');
    latest = Math.max(latest ?? -Infinity, timestamp);
  }
  return latest;
}

function isAncestor(repo, head) {
  try {
    git(repo, 'merge-base', '--is-ancestor', head, 'refs/remotes/origin/main');
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function originSlug(repo) {
  const origin = git(repo, 'remote', 'get-url', 'origin').trim();
  const match = /^(?:[\w+.-]+:\/\/[^/]+\/|[^/]+:)([\w.-]+\/[\w.-]+)\/?$/.exec(origin);
  if (!match) throw new Error('origin の URL から owner/name を取得できません');
  return match[1].replace(/\.git$/, '');
}

function hasMergedPr(slug, branch) {
  const prs = JSON.parse(run('gh', [
    'pr', 'list', '--repo', slug, '--head', branch, '--state', 'merged', '--json', 'number',
  ]));
  if (!Array.isArray(prs)) throw new Error('マージ済みPR一覧を読み取れません');
  return prs.length > 0;
}

export function inspectWorktree(worktree, now, checkAncestor, checkPr) {
  const info = { ...worktree, now };
  try {
    info.exists = ifExists(() => statSync(info.path).isDirectory()) ?? false;
    if (info.exists && !info.prunable && !info.resolvedPath) {
      info.updatedAt = latestUpdate(info.path);
      if (!info.main && !isProtected(info.path)) {
        info.dirty = Boolean(git(info.path, 'status', '--porcelain', '--untracked-files=all').trim());
        if (!info.dirty && (info.updatedAt === null || now - info.updatedAt > DAY_MS)) {
          info.ancestor = checkAncestor(info.head);
          if (!info.ancestor && info.branch && checkPr) info.mergedPr = checkPr(info.branch);
        }
      }
    }
  } catch (error) {
    info.error = String(error.stderr?.trim() || error.message).replace(/\s+/g, ' ');
  }
  return {
    path: info.path,
    ...(info.resolvedPath && { resolvedPath: info.resolvedPath }),
    branch: info.branch ?? '(detached)',
    head: info.head?.slice(0, 12) ?? '',
    ...classifyWorktree(info),
    updatedAt: info.updatedAt == null ? null : new Date(info.updatedAt).toISOString(),
  };
}

function markdownCell(value) {
  return String(value ?? '').replaceAll('\\', '&#92;').replaceAll('|', '&#124;').replace(/\r\n?|\n/g, '<br>');
}

function markdown(groups) {
  const lines = ['# Git worktree 棚卸し', ''];
  for (const [category, rows] of groups) {
    lines.push(`## ${category}（${rows.length}件）`, '',
      '| パス | 実パス | ブランチ | HEAD | 区分 | 理由 | 最終更新日時 |',
      '| --- | --- | --- | --- | --- | --- | --- |');
    for (const row of rows) {
      const cells = [row.path, row.resolvedPath, row.branch, row.head, row.category, row.reason, row.updatedAt];
      lines.push(`| ${cells.map(markdownCell).join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function main() {
  const { values } = parseArgs({ options: {
    repo: { type: 'string', multiple: true, default: [
      path.join(homedir(), 'orgiast-claude-rules'),
      path.join(homedir(), '.claude', 'nightly-repo'),
    ] },
    json: { type: 'string' },
    md: { type: 'string' },
    gh: { type: 'boolean' },
  } });
  const now = Date.now();
  const rows = [];
  let scanned = 0;
  for (const value of values.repo) {
    const repo = path.resolve(value);
    if (!isGitRepository(repo)) {
      console.error(`skipped: ${repo} (not a git repository)`);
      continue;
    }
    scanned += 1;
    const worktrees = parseWorktrees(git(repo, 'worktree', 'list', '--porcelain', '-z'));
    const ancestors = new Map();
    const checkAncestor = (head) => {
      if (!head) throw new Error('HEAD を取得できません');
      if (!ancestors.has(head)) ancestors.set(head, isAncestor(repo, head));
      return ancestors.get(head);
    };
    let slug;
    const checkPr = values.gh ? (branch) => hasMergedPr(slug ??= originSlug(repo), branch) : null;
    const commonDir = git(repo, 'rev-parse', '--path-format=absolute', '--git-common-dir').trimEnd();
    rows.push(...resolveWorktreePaths(repo, commonDir, worktrees)
      .map((worktree) => inspectWorktree(worktree, now, checkAncestor, checkPr)));
  }
  if (scanned === 0) throw new Error('no git repositories could be scanned');
  const groups = categories.map((category) => [category, rows.filter((row) => row.category === category)]);
  for (const [category, group] of groups) console.log(`${category}: ${group.length}`);
  console.log(`合計: ${rows.length}`);
  for (const row of rows) console.log(`${row.path}\t${row.branch}\t${row.updatedAt ?? ''}`);
  if (values.json) writeFileSync(values.json, `${JSON.stringify(rows, null, 2)}\n`);
  if (values.md) writeFileSync(values.md, markdown(groups));
}

if (isEntry(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
