#!/usr/bin/env node
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isEntry } from './is-entry.mjs';
import { answerItem, listItems } from './kim-inbox.mjs';

const execFileAsync = promisify(execFile);
export const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

export function extractPullRequests(item) {
  const text = `${item.title || ''}\n${item.text || ''}`;
  const unique = new Map();
  for (const match of text.matchAll(PR_URL_RE)) {
    const pr = { owner: match[1], repo: match[2], number: Number(match[3]) };
    unique.set(`${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase(), pr);
  }
  return [...unique.values()];
}

export async function fetchPullRequestState(pr) {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'view', String(pr.number), '--repo', `${pr.owner}/${pr.repo}`,
    '--json', 'number,state,mergedAt,closedAt',
  ], { encoding: 'utf8', windowsHide: true });
  return JSON.parse(stdout);
}

export async function findAutocloseCandidates(items, { fetchState = fetchPullRequestState } = {}) {
  const cache = new Map();
  const failures = [];
  const skipped = [];
  const candidates = [];

  async function stateFor(pr) {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();
    if (!cache.has(key)) {
      cache.set(key, Promise.resolve().then(() => fetchState(pr)).catch(error => ({
        error: error?.message || String(error),
      })));
    }
    return cache.get(key);
  }

  for (const item of items.filter(item => item.kind === 'ask' && item.status === 'open')) {
    const prs = extractPullRequests(item);
    if (!prs.length) { skipped.push({ id: item.id, reason: 'PR URLなし' }); continue; }
    const states = await Promise.all(prs.map(async pr => ({ ...pr, ...(await stateFor(pr)) })));
    const unknown = states.filter(pr => pr.error);
    if (unknown.length) {
      for (const pr of unknown) failures.push({ id: item.id, pr: `${pr.owner}/${pr.repo}#${pr.number}`, reason: pr.error });
      skipped.push({ id: item.id, reason: 'PR状態取得失敗', prs: states });
      continue;
    }
    if (!states.every(pr => ['MERGED', 'CLOSED'].includes(pr.state))) {
      skipped.push({ id: item.id, reason: 'OPENのPRあり', prs: states });
      continue;
    }
    candidates.push({ id: item.id, prs: states });
  }
  return { candidates, skipped, failures, fetchedPrCount: cache.size };
}

function closeMessage(prs) {
  return prs.map(pr => {
    const at = pr.mergedAt || pr.closedAt || '日時不明';
    return `PR #${pr.number} は ${pr.state}（${at}）のため自動クローズ。判断は不要です。`;
  }).join('\n');
}

export async function runAutoclose({
  home = process.env.ORGIAST_HOME || os.homedir(), apply = false,
  fetchState = fetchPullRequestState, readItems = listItems, answer = answerItem,
} = {}) {
  const result = await findAutocloseCandidates(readItems(home, { status: 'open' }), { fetchState });
  const closed = [];
  if (apply) {
    for (const candidate of result.candidates) {
      answer(home, candidate.id, closeMessage(candidate.prs), 'kim-inbox-autoclose');
      closed.push(candidate.id);
    }
  }
  return { ...result, apply, closed };
}

export function formatResult(result, { json = false } = {}) {
  if (json) return JSON.stringify(result, null, 2);
  const lines = [];
  for (const row of result.candidates) {
    const prs = row.prs.map(pr => `#${pr.number} ${pr.state} ${pr.mergedAt || pr.closedAt || '日時不明'}`).join(', ');
    lines.push(`${row.id} ${prs}`);
  }
  lines.push(`kim-inbox autoclose ${result.apply ? '(apply)' : '(dry-run)'}: 対象 ${result.candidates.length}件 / PR取得 ${result.fetchedPrCount}件 / 取得失敗 ${result.failures.length}件`);
  return lines.join('\n');
}

export async function main(args = process.argv.slice(2), io = {}) {
  const json = args.includes('--json');
  try {
    const result = await runAutoclose({ ...io, apply: args.includes('--apply') });
    (io.stdout || console.log)(formatResult(result, { json }));
    for (const failure of result.failures) (io.stderr || console.error)(`kim-inbox-autoclose: ${failure.id} ${failure.pr}: ${failure.reason}`);
    return 0;
  } catch (error) {
    (io.stderr || console.error)(`kim-inbox-autoclose: ${error?.message || error}`);
    return 1;
  }
}

if (isEntry(import.meta.url)) process.exitCode = await main();
