#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

// https / ssh どちらの remote でも owner/repo を取り出す。github.com 以外は null。
function parseGithubRemote(url) {
  const match = String(url || '').trim()
    .match(/^(?:https?:\/\/|ssh:\/\/|git:\/\/)?(?:[^@/\s]+@)?github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return match ? { owner: match[1], repo: match[2] } : null;
}

// gh が無い/未認証の環境で merged PR を引く。トークンは子プロセスの stdin だけに渡し、
// argv・ログ・例外文には出さない（子は status と body だけを stdout に書く）。
const REST_SCRIPT = [
  'const url = process.argv[1];',
  'let token = "";',
  'process.stdin.on("data", d => { token += d; }).on("end", async () => {',
  '  try {',
  '    const r = await fetch(url, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token.trim()}`, "User-Agent": "commit-landed" } });',
  '    process.stdout.write(JSON.stringify({ status: r.status, body: await r.text() }));',
  '  } catch (error) { process.exit(1); }',
  '});',
].join('');

// run has the spawnSync interface so tests need neither GitHub nor a real repo.
export function commitLanded(sha, { base = 'origin/main', cwd = process.cwd(), run = spawnSync } = {}) {
  for (const ref of [sha, base]) {
    if (typeof ref !== 'string' || !ref || ref.startsWith('-')) throw new Error('Expected a commit reference');
  }
  const result = (via = null, pr = null, mergeCommit = null) => ({ sha, landed: via !== null, via, pr, mergeCommit });
  const invoke = (exe, args, input) => run(exe, args, { cwd, input, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024 });
  const git = args => {
    const r = invoke('git', args);
    if (r.error || r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.error?.message || r.stderr || r.status}`);
    return r.stdout || '';
  };
  const ancestor = invoke('git', ['merge-base', '--is-ancestor', sha, base]);
  if (!ancestor.error && ancestor.status === 0) return result('ancestor');
  let ghWorked = false;
  try {
    const found = invoke('gh', ['pr', 'list', '--state', 'merged', '--search', sha, '--json', 'number,mergedAt,mergeCommit,commits']);
    ghWorked = !found.error && found.status === 0;
    if (ghWorked) {
      const prs = JSON.parse(found.stdout);
      const resolved = invoke('git', ['rev-parse', '--verify', `${sha}^{commit}`]);
      const fullSha = !resolved.error && resolved.status === 0 ? (resolved.stdout || '').trim() : '';
      // Search also matches PR body text; only commit membership is evidence.
      const pr = Array.isArray(prs) && prs.find(p => p.number && p.mergedAt &&
        Array.isArray(p.commits) && p.commits.some(commit =>
          typeof commit.oid === 'string' && (fullSha ? commit.oid === fullSha : commit.oid.startsWith(sha))));
      if (pr) return result('pr', pr.number, pr.mergeCommit?.oid || null);
    }
  } catch { /* Missing/broken gh must not prevent local patch comparison. */ }
  // gh が無い・未認証の PC では squash マージが patch-id で一致しない。REST で先に判定する。
  if (!ghWorked) {
    try {
      const remote = invoke('git', ['remote', 'get-url', 'origin']);
      const repo = !remote.error && remote.status === 0 ? parseGithubRemote(remote.stdout) : null;
      const auth = repo ? invoke('git', ['credential', 'fill'], 'protocol=https\nhost=github.com\n\n') : null;
      const token = !auth?.error && auth?.status === 0 ? String(auth.stdout || '').match(/^password=(.+)$/m)?.[1].trim() : null;
      if (repo && token) {
        const resolved = invoke('git', ['rev-parse', '--verify', `${sha}^{commit}`]);
        const ref = !resolved.error && resolved.status === 0 ? (resolved.stdout || '').trim() : sha;
        const url = `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits/${ref}/pulls`;
        const fetched = invoke('node', ['-e', REST_SCRIPT, url], token);
        if (!fetched.error && fetched.status === 0) {
          const response = JSON.parse(fetched.stdout || '{}');
          const pulls = response.status === 200 ? JSON.parse(response.body || '[]') : [];
          const merged = Array.isArray(pulls) && pulls.find(pull => pull?.number && pull.merged_at);
          if (merged) return result('pr', merged.number, merged.merge_commit_sha || null);
        }
      }
    } catch { /* Network/auth failures fall through to local patch comparison. */ }
  }
  const patchIds = patch => {
    const r = invoke('git', ['patch-id', '--stable'], patch);
    if (r.error || r.status !== 0) throw new Error(`git patch-id failed: ${r.error?.message || r.stderr || r.status}`);
    return (r.stdout || '').trim().split('\n').filter(Boolean).map(line => line.split(/\s+/)[0]);
  };
  const candidates = patchIds(git(['show', '--pretty=medium', '--no-ext-diff', '--no-textconv', sha, '--']));
  const fork = git(['merge-base', sha, base]).trim();
  if (Number(git(['rev-list', '--count', `${fork}..${sha}`, '--']).trim()) > 1) {
    candidates.push(...patchIds(git(['diff', '--no-ext-diff', '--no-textconv', `${fork}..${sha}`, '--'])));
  }
  const recent = new Set(patchIds(git(['log', '-300', '-p', '--pretty=medium', '--no-ext-diff', '--no-textconv', base, '--'])));
  return candidates.some(id => recent.has(id)) ? result('patch-id') : result();
}

export function main(argv = process.argv.slice(2), deps = {}) {
  const [sha, ...args] = argv;
  const options = {}; let json = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (['--base', '--cwd'].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith('--')) options[args[i].slice(2)] = args[++i];
    else throw new Error(`Unknown or incomplete option: ${args[i]}`);
  }
  const value = commitLanded(sha, { ...options, ...deps });
  console.log(json ? JSON.stringify(value) : `${sha}: ${value.landed ? `landed (${value.via})` : 'not landed'}${value.pr ? ` PR #${value.pr} mergeCommit=${value.mergeCommit}` : ''}`);
  return value.landed ? 0 : 1;
}
if (isEntry(import.meta.url)) {
  try { process.exitCode = main(); }
  catch (error) { console.error(error.message); process.exitCode = 2; }
}
