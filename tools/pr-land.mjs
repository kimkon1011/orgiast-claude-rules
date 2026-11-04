#!/usr/bin/env node
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import { isKimOperated } from './lib/kim-operated.mjs';
import { command, repositoryTarget } from './lib/seat-github.mjs';
import { firstGuardedPath } from './pr-merge-eligibility.mjs';
import { mergePr } from './pr-merge.mjs';

export function landingRoute(files) {
  if (files.some(file => file.startsWith('.github/workflows/'))) return 'workflow-stop';
  return firstGuardedPath(files) ? 'self-merge' : 'automerge';
}
export function waitForCi(pr, repo, { run, now = Date.now,
  sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms), timeoutMs = 20 * 60_000 } = {}) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    // PR作成直後はチェックが未登録。checks --watch の即時exitを完了と取り違えず登録も待つ。
    const { statusCheckRollup: checks } = JSON.parse(run('gh', ['pr', 'view', String(pr), '--repo', repo, '--json', 'statusCheckRollup']));
    if (!Array.isArray(checks)) throw new Error('CI 状態を確認できません');
    const state = check => check.__typename === 'CheckRun'
      ? (check.status === 'COMPLETED' ? (check.conclusion === 'SUCCESS' ? 'pass' : 'fail') : 'pending')
      : check.__typename === 'StatusContext' ? (check.state === 'SUCCESS' ? 'pass' : check.state === 'PENDING' ? 'pending' : 'fail') : 'fail';
    if (checks.some(check => state(check) === 'fail')) throw new Error(`PR #${pr}: CI 失敗。この席で修正して pr-land を再実行`);
    if (checks.length && checks.every(check => state(check) === 'pass')) return;
    sleep(Math.min(5000, Math.max(0, deadline - now())));
  }
  throw new Error(`PR #${pr}: CI 待機の上限。gh pr checks ${pr} --repo ${repo} で確認し、この席で pr-land を再実行`);
}
// 呼出側の run を共有し、テストは実 git/gh・ネットワークを使わない。
export function publishSeatPr({ cwd = process.cwd(), home = process.env.ORGIAST_HOME || os.homedir(),
  branch, base, title, body, bodyFile, fill = false, run = (file, args, options) => command(file, args, cwd, options), out = console.log, ci = {} } = {}) {
  if (!isKimOperated(home)) return null;
  const target = repositoryTarget(run);
  if (!target.push) throw new Error('base の push 権限なし。node tools/access-doctor.mjs --fix をこの席で実行');
  branch ||= run('git', ['branch', '--show-current']);
  base ||= target.defaultBranch;
  if (!branch || branch === base || branch.startsWith('-') || base.startsWith('-')) throw new Error('作業ブランチが必要です');
  run('git', ['check-ref-format', '--branch', branch]);
  run('git', ['check-ref-format', '--branch', base]);
  const head = run('git', ['rev-parse', 'HEAD']);
  if (!/^[a-f0-9]{40}$/i.test(head) || run('git', ['rev-parse', `refs/heads/${branch}`]) !== head) throw new Error('作業ブランチと HEAD が一致しません');
  run('git', ['fetch', target.url, base]);
  const files = run('git', ['diff', '--no-renames', '--name-only', '-z', `FETCH_HEAD...${head}`]).split('\0').filter(Boolean);
  const route = landingRoute(files);
  if (route === 'workflow-stop') throw new Error('.github/workflows/ を含むため停止。workflow 権限とレビューの専用経路で扱ってください');
  // origin が fork でも、確認した base に明示的に push。remote 設定には副作用を出さない。
  run('git', ['push', target.url, `${head}:refs/heads/${branch}`]);
  const existing = JSON.parse(run('gh', ['pr', 'list', '--repo', target.base, '--head', `${target.base.split('/')[0]}:${branch}`, '--base', base, '--state', 'open', '--json', 'number,url']));
  let pr = existing[0];
  if (!pr) {
    const args = ['pr', 'create', '--repo', target.base, '--base', base, '--head', branch]; // automerge は安全パスでのみ後付け
    if (title) args.push('--title', title);
    if (bodyFile) args.push('--body-file', bodyFile);
    else if (body !== undefined) args.push('--body', body);
    if (fill) args.push('--fill');
    const url = run('gh', args).trim();
    const match = url.match(/\/pull\/(\d+)$/);
    if (!match) throw new Error('作成した PR の URL を確認できません');
    pr = { number: Number(match[1]), url };
  }
  const remote = JSON.parse(run('gh', ['pr', 'view', String(pr.number), '--repo', target.base, '--json', 'headRefOid,isDraft']));
  if (remote.headRefOid !== head || remote.isDraft) throw new Error('PR の HEAD 不一致または draft のため着地を停止');
  if (route === 'automerge') {
    run('gh', ['pr', 'edit', String(pr.number), '--repo', target.base, '--add-label', 'automerge']);
    const labels = JSON.parse(run('gh', ['pr', 'view', String(pr.number), '--repo', target.base, '--json', 'labels'])).labels;
    if (!labels?.some(label => label.name === 'automerge')) throw new Error('automerge ラベルの read-back 不一致');
  } else {
    // 既存PRのラベルも外し、CI全成功後に既存レビュー・SHA固定・read-backを通す。
    run('gh', ['pr', 'edit', String(pr.number), '--repo', target.base, '--remove-label', 'automerge']);
    out(`PR #${pr.number}: CI 合格後、この席で gh pr merge --squash を実行（pr-merge の検証を使用）`);
    waitForCi(pr.number, target.base, { ...ci, run });
    mergePr({ pr: pr.number, repo: cwd, githubRepo: target.base, method: 'squash', keepBranch: true }, {
      exec: (file, args) => run(file, args),
    });
  }
  return { ...pr, route, repo: target.base };
}
export function main(argv = process.argv.slice(2), deps = {}) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--fill') { options.fill = true; continue; }
    const name = { '--title': 'title', '--body-file': 'bodyFile', '--branch': 'branch', '--base': 'base' }[argv[i]];
    if (!name || !argv[i + 1] || argv[i + 1].startsWith('--')) return 2;
    options[name] = argv[++i];
  }
  try {
    const result = publishSeatPr({ ...options, ...deps });
    if (!result) throw new Error('kim 操作席専用です');
    (deps.out || console.log)(result.url);
    return 0;
  } catch (error) { (deps.out || console.error)(`pr-land: ${error.message}`); return 1; }
}
if (isEntry(import.meta.url)) process.exitCode = main();
