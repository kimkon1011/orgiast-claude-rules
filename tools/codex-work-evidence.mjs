import { spawnSync } from 'node:child_process';

// Read back reported artifacts; prose saying "implemented" or an old PR is not evidence.
export function verifyExternalWork({ output = '', cwd, started, status, timedOut }, { spawnImpl = spawnSync, platform = process.platform } = {}) {
  if (status !== 0 || timedOut || !Number.isFinite(started)) return null;
  const deadline = Date.now() + 10000;
  const run = (command, args) => {
    if (Date.now() >= deadline) return null;
    try {
      const result = spawnImpl(command, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: Math.max(1, Math.min(5000, deadline - Date.now())) });
      return result?.status === 0 ? String(result.stdout || '').trim() : null;
    } catch { return null; }
  };
  const fresh = value => Number.isFinite(value) && value >= started - 1000 && value <= Date.now() + 1000;
  const urls = [...new Set(String(output).match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\b/g) || [])].slice(0, 4);
  for (const url of urls) {
    try {
      const pr = JSON.parse(run('gh', ['pr', 'view', url, '--json', 'url,createdAt,headRefOid,commits']));
      if (pr?.url === url && fresh(Date.parse(pr.createdAt)) && /^[a-f0-9]{40}$/i.test(pr.headRefOid || '') && pr.commits?.length) {
        return { kind: 'pull-request', url };
      }
    } catch { /* Missing auth/network or stale references do not establish success. */ }
  }
  const paths = [...new Set([...String(output).matchAll(/(?:^|[\s`"'(])((?:\/[\w.-]+|[A-Za-z]:[\\/])[^\s`"'<>\r\n)]*)/gm)].map(m => m[1]))].slice(0, 8);
  const hashes = [...new Set([...String(output).matchAll(/(?:\bcommit(?:ted)?\s*[:：]?\s*|\[[^\]\r\n]+\s)([a-f0-9]{7,40})\b/gi)].map(m => m[1]))].slice(0, 4);
  for (const repo of paths) {
    // Windows Codex runs in WSL; its /tmp clone is not a Windows filesystem path.
    const git = args => platform === 'win32' && repo.startsWith('/') && !repo.startsWith('//')
      ? run('wsl', ['--exec', 'git', '-C', repo, ...args])
      : run('git', ['-C', repo, ...args]);
    for (const hash of hashes) {
      const info = git(['show', '-s', '--format=%H%n%ct', hash, '--']);
      const [sha, timestamp] = (info || '').split(/\r?\n/);
      if (!sha?.toLowerCase().startsWith(hash.toLowerCase()) || !fresh(Number(timestamp) * 1000)) continue;
      if (git(['merge-base', '--is-ancestor', sha, 'HEAD']) === null) continue;
      return { kind: 'commit', repo, sha };
    }
  }
  return null;
}
