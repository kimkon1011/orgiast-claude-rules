import { wslInstalled } from './lib/wsl-present.mjs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

// Read back reported artifacts; prose saying "implemented" or an old PR is not evidence.
export function verifyExternalWork({ output = '', cwd, started, status, timedOut }, { spawnImpl = spawnSync, platform = process.platform, wslPresent = wslInstalled, now = Date.now } = {}) {
  if (status !== 0 || timedOut || !Number.isFinite(started)) return null;
  // Windows gh can take over 20s even for a valid PR. Keep a bounded network
  // budget separate from local commit probes, rather than silently killing it at 5s.
  let deadline = now() + 60000;
  const run = (command, args, { runCwd = cwd, timeout = 5000 } = {}) => {
    if (now() >= deadline) return null;
    try {
      const result = spawnImpl(command, args, { cwd: runCwd, encoding: 'utf8', windowsHide: true, timeout: Math.max(1, Math.min(timeout, deadline - now())) });
      return result?.status === 0 ? String(result.stdout || '').trim() : null;
    } catch { return null; }
  };
  const fresh = value => Number.isFinite(value) && value >= started - 1000 && value <= now() + 1000;
  const urls = [...new Set(String(output).match(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\b/g) || [])].slice(0, 4);
  for (const url of urls) {
    try {
      // A URL identifies the repository; neither cwd discovery nor fetching the
      // entire commit history is needed to verify a newly created PR.
      const pr = JSON.parse(run('gh', ['pr', 'view', url, '--json', 'url,createdAt'], { runCwd: tmpdir(), timeout: 30000 }));
      if (pr?.url === url && fresh(Date.parse(pr.createdAt))) {
        return { kind: 'pull-request', url };
      }
    } catch { /* Missing auth/network or stale references do not establish success. */ }
  }
  deadline = now() + 10000;
  const paths = [...new Set([...String(output).matchAll(/(?:^|[\s`"'(])((?:\/[\w.-]+|[A-Za-z]:[\\/])[^\s`"'<>\r\n)]*)/gm)].map(m => m[1]))].slice(0, 8);
  const hashes = [...new Set([...String(output).matchAll(/(?:\bcommit(?:ted)?\s*[:：]?\s*|\[[^\]\r\n]+\s)([a-f0-9]{7,40})\b/gi)].map(m => m[1]))].slice(0, 4);
  for (const repo of paths) {
    // Windows Codex runs in WSL; its /tmp clone is not a Windows filesystem path.
    const git = args => platform === 'win32' && repo.startsWith('/') && !repo.startsWith('//')
      ? (wslPresent({ platform }) ? run('wsl', ['--exec', 'git', '-C', repo, ...args]) : null)
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
