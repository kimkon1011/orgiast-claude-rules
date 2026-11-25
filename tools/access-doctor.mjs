#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { isKimOperated } from './lib/kim-operated.mjs';
import { acceptInvites, trustedInvitation } from './gh-accept-invites.mjs';
import { api, command, pages, repositoryTarget, repairOrigin, OWNER,
  originReachability, repairUnreachableOrigin, makeRepoRun } from './lib/seat-github.mjs';
import { getSyncedRepoRoot } from './resolve-synced-repo.mjs';

export function diagnose({ fix = false, home = process.env.ORGIAST_HOME || os.homedir(), cwd = process.cwd(),
  run = (file, args) => command(file, args, cwd), status, out = console.log } = {}) {
  const rows = [], add = (resource, ok, repair) => rows.push({ resource, ok, repair });
  const kim = isKimOperated(home);
  let pending = [];
  try {
    pending = pages(run, 'user/repository_invitations?per_page=100').filter(trustedInvitation);
    if (fix && pending.length && kim) acceptInvites({ home, run, out });
    if (fix && pending.length && kim) pending = pages(run, 'user/repository_invitations?per_page=100').filter(trustedInvitation);
    add('GitHub 招待', pending.length === 0, pending.length ? 'node tools/gh-accept-invites.mjs' : '保留なし');
    // user/repos は private の collaborator リポも含む。users/:owner/repos と併合し公開リポの権限欠落も診断。
    const repos = new Map([...pages(run, `users/${OWNER}/repos?per_page=100`), ...pages(run, 'user/repos?per_page=100')]
      .filter(repo => repo.owner?.login?.toLowerCase() === OWNER).map(repo => [repo.full_name, repo]));
    for (const invitation of pending) repos.set(invitation.repository.full_name, invitation.repository);
    for (const name of [...repos.keys()].sort()) {
      try { const repo = api(run, `repos/${name}`); add(name, repo.permissions?.push === true, repo.permissions?.push ? 'push 可' : 'node tools/gh-accept-invites.mjs; gh auth status'); }
      catch { add(name, false, `gh repo view ${name}; gh auth status`); }
    }
    add('リポジトリ一覧', repos.size > 0, 'gh api user/repos --paginate（未招待の非公開リポは列挙不可）');
  } catch { add('GitHub 接続', false, 'gh --version; gh auth status; gh auth login'); }
  try {
    const target = repositoryTarget(run);
    if (fix && kim) repairOrigin(target, run);
    const ready = target.push && (!target.fork || (fix && kim));
    add(`origin → ${target.base}`, ready, ready ? 'base へ push 可' : 'node tools/access-doctor.mjs --fix');
  } catch { add('origin / upstream', false, 'git remote -v; gh auth status; node tools/access-doctor.mjs --fix'); }
  // 配布元リポ（nightly-repo）の origin 到達性。届かない URL のままだとそのPCだけ main の修正が
  // 無言で届かなくなる（PC004 2026-11-05）。--fix で履歴一致を確認してから正しいリポジトリへ戻す。
  try {
    const repoDir = getSyncedRepoRoot({ env: { ...process.env, ORGIAST_HOME: home } });
    if (fs.existsSync(repoDir)) {
      const originRun = makeRepoRun(repoDir);
      let verdict = originReachability({ repoDir, run: originRun });
      if ((verdict.kind === 'not-found' || verdict.kind === 'auth') && fix) verdict = repairUnreachableOrigin({ repoDir, home, run: originRun });
      const ok = verdict.kind === 'ok';
      const hint = ok ? '正しいリポジトリへ届く'
        : verdict.kind === 'not-found' || verdict.kind === 'auth' ? 'node tools/access-doctor.mjs --fix（origin を正しいリポジトリへ戻す・履歴一致のみ）'
        : verdict.kind === 'no-repo' ? 'git リポジトリではない（再配置を確認）'
        : 'ネットワーク断（再試行。自動向け替えはしない）';
      add(`配布元 origin（${path.basename(repoDir)}）`, ok, hint);
    }
  } catch { add('配布元 origin', false, 'git -C ~/.claude/nightly-repo ls-remote origin HEAD を確認'); }
  try {
    const result = status ? status() : JSON.parse(run(process.execPath, [fileURLToPath(new URL('./keyserve-status.mjs', import.meta.url)), '--json']));
    add('keyserve 配布一覧', result.success === true, 'node tools/onboarding-sync.mjs --keys-only --force');
    for (const name of result.files || []) {
      if (!/^[A-Za-z0-9._-]+$/.test(name) || name.includes('..')) continue;
      add(`配布ファイル ${name}`, fs.existsSync(path.join(home, '.claude', name)), 'node tools/onboarding-sync.mjs --keys-only --force');
    }
  } catch { add('keyserve 配布一覧', false, 'node tools/onboarding-sync.mjs --keys-only --force'); }
  out('| 対象 | できる／できない | 直し方（この席で実行） |');
  out('| --- | --- | --- |');
  for (const row of rows) out(`| ${row.resource} | ${row.ok ? 'できる' : 'できない'} | ${row.repair} |`);
  return rows;
}
export function main(argv = process.argv.slice(2), deps = {}) {
  const flagAt = argv.indexOf('--origin-repair');
  const originRepairArg = flagAt >= 0 ? argv[flagAt + 1] : undefined;
  const allowedPosition = flagAt >= 0 ? [flagAt, flagAt + 1] : [];
  const invalid = (flagAt >= 0 && originRepairArg === undefined)
    || argv.some((arg, i) => arg !== '--fix' && !(flagAt >= 0 && (i === flagAt || i === flagAt + 1)));
  if (invalid) return 2;
  // setup-manifest の repair 経路: 配布元リポのみの検査・修復（gh に依存しない）
  if (originRepairArg !== undefined) {
    const home = deps.home || process.env.ORGIAST_HOME || os.homedir();
    const repoDir = path.isAbsolute(originRepairArg) ? path.resolve(originRepairArg) : path.join(home, originRepairArg);
    const note = repairUnreachableOrigin({ repoDir, home, run: deps.run || makeRepoRun(repoDir) });
    console.log(`配布元 origin: ${note.repaired ? `正しいリポジトリへ向け替えました（旧: ${note.originUrl}）` : `変更なし（${note.kind}）`}`);
    return 0;
  }
  diagnose({ ...deps, fix: argv.includes('--fix') });
  return 0;
}
if (isEntry(import.meta.url)) process.exitCode = main();
