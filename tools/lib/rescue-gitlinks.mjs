import { spawnSync } from 'node:child_process';

function git(tree, args, env) {
  const result = spawnSync('git', ['-C', tree, ...args], {
    env, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const first = (result.stderr || result.error?.message || `exit ${result.status}`).trim().split(/\r?\n/)[0];
    throw new Error(`${args[0]}: ${first}`);
  }
  return result.stdout;
}

// Inspect the index after staging. A nested repository can appear between status
// and add, and Git records it as mode 160000 even when it is not a submodule.
export function unstageUndeclaredGitlinks(tree, env = process.env) {
  const stagedLinks = git(tree, ['ls-files', '--stage'], env)
    .split(/\r?\n/).filter(line => line.startsWith('160000 '))
    .map(line => line.slice(line.indexOf('\t') + 1));
  if (!stagedLinks.length) return [];
  const known = new Set(git(tree, ['ls-tree', '-r', 'HEAD'], env)
    .split(/\r?\n/).filter(line => line.startsWith('160000 '))
    .map(line => line.slice(line.indexOf('\t') + 1)));
  const dropped = stagedLinks.filter(name => !known.has(name));
  if (dropped.length) git(tree, ['rm', '--cached', '-f', '-q', '--', ...dropped], env);
  return dropped;
}
