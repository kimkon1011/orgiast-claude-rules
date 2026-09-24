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
  const gh = args => String(exec('gh', args, { cwd: repo, encoding: 'utf8', timeout: 60_000, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })).trim();
  const view = JSON.parse(gh(['pr', 'view', pr, '--json', 'state,mergeable,reviewDecision,statusCheckRollup,headRefOid']));
  if (view.state !== 'OPEN') throw new Error(`PR #${pr}: state=${view.state}（OPEN が必要）`);
  if (view.mergeable !== 'MERGEABLE') throw new Error(`PR #${pr}: mergeable=${view.mergeable}`);
  if (view.reviewDecision === 'CHANGES_REQUESTED') throw new Error(`PR #${pr}: CHANGES_REQUESTED`);
  const rollup = view.statusCheckRollup;
  if (!Array.isArray(rollup) || !rollup.length) throw new Error(`PR #${pr}: チェック未登録・未確認`);
  const unsuccessful = rollup.filter(check => check.__typename === 'CheckRun'
    ? check.status !== 'COMPLETED' || check.conclusion !== 'SUCCESS'
    : check.__typename === 'StatusContext' ? check.state !== 'SUCCESS' : true);
  if (unsuccessful.length) throw new Error(`PR #${pr}: 全チェック成功ではありません (${unsuccessful.map(c => c.name || c.context || 'unknown').join(', ')})`);
  const checks = JSON.parse(gh(['pr', 'checks', pr, '--json', 'name,bucket,state']));
  if (!Array.isArray(checks) || !checks.length || checks.some(check => check.bucket !== 'pass')) throw new Error(`PR #${pr}: gh pr checks が全成功ではありません`);
  // 検査後に新しいpushが入った場合は、未検査のheadをマージしない。
  if (!/^[a-f0-9]{40}$/i.test(view.headRefOid || '')) throw new Error(`PR #${pr}: head SHA を確認できません`);
  gh(['pr', 'merge', pr, `--${method}`, '--delete-branch', '--match-head-commit', view.headRefOid]);
  const result = JSON.parse(gh(['pr', 'view', pr, '--json', 'state,mergedAt']));
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
