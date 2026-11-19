#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

export function parseArgs(args) {
  const [pr, ...rest] = args;
  if (!/^[1-9]\d*$/.test(pr || '')) throw new Error('Usage: pr-merge.mjs <PR番号> [--repo <path>] [--method squash|merge]');
  const options = { pr, repo: process.cwd(), method: 'squash' };
  const seen = new Set();
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i], value = rest[i + 1];
    if (!['--repo', '--method'].includes(flag) || !value || value.startsWith('--') || seen.has(flag)) throw new Error(`不正な引数: ${flag}`);
    seen.add(flag);
    options[flag.slice(2)] = value;
  }
  if (!['squash', 'merge'].includes(options.method)) throw new Error('method は squash / merge のみ');
  options.repo = path.resolve(options.repo);
  return options;
}

export function mergePr(options, { exec = execFileSync } = {}) {
  const { pr, repo, method } = parseArgs([String(options.pr), '--repo', options.repo || process.cwd(), '--method', options.method || 'squash']);
  const configuredTimeout = process.env.PR_MERGE_GH_TIMEOUT_MS?.trim() || '';
  const timeoutMs = Number(configuredTimeout);
  const timeout = /^\d+$/.test(configuredTimeout) && timeoutMs > 0 && timeoutMs <= 2_147_483_647
    ? timeoutMs : 180_000;
  const gh = (args, retryOnTimeout = false) => {
    const commandArgs = options.githubRepo && args[0] === 'pr' ? [...args, '--repo', options.githubRepo] : args;
    const attempts = retryOnTimeout ? 2 : 1;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return String(exec('gh', commandArgs, {
          cwd: repo, encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        })).trim();
      } catch (error) {
        if (error.code !== 'ETIMEDOUT') throw error;
        if (attempt === attempts) {
          throw new Error(`gh が ${timeout} ms 以内に応答しませんでした（PC 高負荷の可能性。PR_MERGE_GH_TIMEOUT_MS で延長可）`, { cause: error });
        }
      }
    }
  };
  const ghRead = args => gh(args, true);
  const view = JSON.parse(ghRead(['pr', 'view', pr, '--json', 'state,mergeable,reviewDecision,statusCheckRollup,headRefOid,headRefName']));
  const repository = options.githubRepo || JSON.parse(ghRead(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
  // --json files は上限があるため REST の全ページで workflow 変更を確認する。
  const files = JSON.parse(ghRead(['api', '--paginate', '--slurp', `repos/${repository}/pulls/${pr}/files?per_page=100`]));
  if (!Array.isArray(files) || files.some(page => !Array.isArray(page))) throw new Error('PR 変更パスを確認できません');
  if (files.flat().some(file => [file.filename, file.previous_filename].some(name => name?.startsWith('.github/workflows/')))) throw new Error('.github/workflows/ を含む PR は専用経路で扱うため停止');
  if (view.state !== 'OPEN') throw new Error(`PR #${pr}: state=${view.state}（OPEN が必要）`);
  if (view.mergeable !== 'MERGEABLE') throw new Error(`PR #${pr}: mergeable=${view.mergeable}`);
  if (view.reviewDecision === 'CHANGES_REQUESTED') throw new Error(`PR #${pr}: CHANGES_REQUESTED`);
  const rollup = view.statusCheckRollup;
  if (!Array.isArray(rollup) || !rollup.length) throw new Error(`PR #${pr}: チェック未登録・未確認`);
  const unsuccessful = rollup.filter(check => check.__typename === 'CheckRun'
    ? check.status !== 'COMPLETED' || check.conclusion !== 'SUCCESS'
    : check.__typename === 'StatusContext' ? check.state !== 'SUCCESS' : true);
  if (unsuccessful.length) throw new Error(`PR #${pr}: 全チェック成功ではありません (${unsuccessful.map(c => c.name || c.context || 'unknown').join(', ')})`);
  const checks = JSON.parse(ghRead(['pr', 'checks', pr, '--json', 'name,bucket,state']));
  if (!Array.isArray(checks) || !checks.length || checks.some(check => check.bucket !== 'pass')) throw new Error(`PR #${pr}: gh pr checks が全成功ではありません`);
  // 検査後に新しいpushが入った場合は、未検査のheadをマージしない。
  if (!/^[a-f0-9]{40}$/i.test(view.headRefOid || '')) throw new Error(`PR #${pr}: head SHA を確認できません`);
  try {
    gh(['pr', 'merge', pr, `--${method}`, ...(options.keepBranch ? [] : ['--delete-branch']), '--match-head-commit', view.headRefOid]);
  } catch (error) {
    const message = `${error.stderr || ''}\n${error.message || ''}`;
    if (!/MergePullRequest/i.test(message) || !/permission/i.test(message)) throw error;
    const nameWithOwner = repository;
    const result = JSON.parse(gh(['api', '-X', 'PUT', `repos/${nameWithOwner}/pulls/${pr}/merge`, '-f', `merge_method=${method}`, '-f', `sha=${view.headRefOid}`]));
    if (result.merged !== true) throw new Error(`PR #${pr}: REST マージ失敗 (${result.message || 'merged != true'})`);
    if (!options.keepBranch && view.headRefName) {
      try {
        gh(['api', '-X', 'DELETE', `repos/${nameWithOwner}/git/refs/heads/${encodeURIComponent(view.headRefName)}`]);
      } catch {} // ブランチ削除の失敗はマージ成否に影響させない。
    }
  }
  const result = JSON.parse(ghRead(['pr', 'view', pr, '--json', 'state,mergedAt']));
  if (result.state !== 'MERGED' || !result.mergedAt) throw new Error(`PR #${pr}: マージ後の read-back が MERGED ではありません`);
  return { pr, ...result };
}

export function main(args = process.argv.slice(2), dependencies) {
  try {
    const result = mergePr(parseArgs(args), dependencies);
    console.log(`PR #${result.pr}: MERGED (${result.mergedAt})`);
    return 0;
  } catch (error) {
    console.error(`pr-merge: ${error.message}`);
    return 1;
  }
}
if (isEntry(import.meta.url)) process.exitCode = main();
