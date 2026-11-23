#!/usr/bin/env node
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isEntry } from './is-entry.mjs';
import { answerItem, listItems, updateInboxItem } from './kim-inbox.mjs';

const execFileAsync = promisify(execFile);
export const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;
export const USAGE = `Usage: node tools/kim-inbox-autoclose.mjs [options]

Options:
  (no arguments)          List asks whose pull requests have landed (dry-run)
  --apply                 Close the listed asks
  --backfill-url          List candidates for adding full URLs to asks with only PR numbers (dry-run)
  --backfill-url --apply  Add the full URLs to those candidates
  --json                  Output the result as JSON
  --help, -h              Show this help without side effects`;

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
    '--json', 'number,title,state,mergedAt,closedAt',
  ], { encoding: 'utf8', windowsHide: true });
  return JSON.parse(stdout);
}

const SHORT_PR_RE = /#(\d{1,6})(?!\w)/g;
const REPO_TOKEN_RE = /\b[a-z0-9][a-z0-9._]*-[a-z0-9._-]+\b/gi;

export function extractShortPullRequestNumbers(item) {
  const text = `${item.title || ''}\n${item.text || ''}`;
  if ([...text.matchAll(PR_URL_RE)].length) return [];
  return [...new Set([...text.matchAll(SHORT_PR_RE)].filter(match => match[1].length !== 6).map(match => Number(match[1])))];
}

function extractShortPullRequestReferences(item) {
  const text = `${item.title || ''}\n${item.text || ''}`;
  if ([...text.matchAll(PR_URL_RE)].length) return [];
  const seen = new Set();
  const references = [];
  for (const match of text.matchAll(SHORT_PR_RE)) {
    if (match[1].length === 6) continue;
    const number = Number(match[1]);
    if (seen.has(number)) continue;
    seen.add(number);
    references.push({ number, context: text.slice(Math.max(0, match.index - 180), match.index + match[0].length + 180) });
  }
  return references;
}

export function inferBackfillRepos(item, defaultRepo = 'kimkon1011/orgiast-claude-rules') {
  const text = `${item.title || ''}\n${item.text || ''}`;
  const github = text.match(/github\.com\/([\w.-]+)\/([\w.-]+)(?:\/|\b)/i);
  const candidates = [];
  if (github && `${github[1]}/${github[2]}`.toLowerCase() !== defaultRepo.toLowerCase()) candidates.push(`${github[1]}/${github[2]}`);
  const defaultName = defaultRepo.split('/')[1].toLowerCase();
  for (const token of [...text.matchAll(REPO_TOKEN_RE)].map(match => match[0])) {
    if (token.toLowerCase() !== defaultName) candidates.push(`kimkon1011/${token}`);
  }
  candidates.push(defaultRepo);
  return [...new Set(candidates)];
}

function clueTokens(value) {
  return [...new Set(String(value ?? '').normalize('NFKC').toLowerCase().match(/[a-z0-9]{4,}|[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{3,}/gu) || [])]
    .filter(token => !['github', 'pull', 'request', '判断してください', '確認してください', 'orgiast', 'origin', 'main', 'tools', 'tool', 'node', 'auto', 'lane', 'session', 'claims', 'filter', 'inbox', 'info', 'kind'].includes(token));
}

export function backfillMatchReason(item, pr, repo) {
  const askTokens = clueTokens(`${item.title || ''}\n${item.text || ''}`);
  const titleTokens = clueTokens(pr.title);
  const common = titleTokens.filter(token => askTokens.some(ask => ask.includes(token) || token.includes(ask)));
  const strong = common.filter(token => /[^\x00-\x7f]/.test(token) ? token.length >= 4 : token.length >= 6);
  if (strong.length < 2 && !strong.some(token => token.length >= 8)) return null;
  return `PRタイトル共通語: ${strong.slice(0, 3).join(', ')}; repo=${repo}`;
}

export async function findBackfillCandidates(items, { fetchPr = fetchPullRequestState, defaultRepo = 'kimkon1011/orgiast-claude-rules' } = {}) {
  const jobs = [];
  for (const item of items.filter(item => item.kind === 'ask' && item.status === 'open')) {
    for (const reference of extractShortPullRequestReferences(item)) jobs.push({ item, ...reference });
  }
  const cache = new Map();
  const fetchCached = pr => {
    const key = `${pr.owner}/${pr.repo}#${pr.number}`.toLowerCase();
    if (!cache.has(key)) cache.set(key, Promise.resolve().then(() => fetchPr(pr)));
    return cache.get(key);
  };
  const rows = new Array(jobs.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= jobs.length) return;
      const { item, number, context } = jobs[index];
      const scopedItem = { ...item, text: context };
      const attempted = [];
      let fallback = null;
      for (const repo of inferBackfillRepos(item, defaultRepo)) {
        const [owner, name] = repo.split('/');
        const url = `https://github.com/${repo}/pull/${number}`;
        try {
          const pr = await fetchCached({ owner, repo: name, number });
          const reason = backfillMatchReason(scopedItem, pr, repo);
          const row = { id: item.id, title: item.title || String(item.text || '').split(/\r?\n/)[0], url, state: pr.state, reason: reason || 'skip: PRタイトルとの共通手がかりなし', apply: Boolean(reason) };
          if (reason) { fallback = row; break; }
          fallback ||= row;
        } catch (error) { attempted.push(`${repo}: ${error?.message || error}`); }
      }
      rows[index] = fallback || { id: item.id, title: item.title || String(item.text || '').split(/\r?\n/)[0], url: `https://github.com/${defaultRepo}/pull/${number}`, state: 'UNKNOWN', reason: `skip: PR取得失敗 (${attempted.join('; ')})`, apply: false };
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
  return rows;
}

export async function runBackfill({ home = process.env.ORGIAST_HOME || os.homedir(), apply = false, fetchPr = fetchPullRequestState, readItems = listItems, updateItem = updateInboxItem } = {}) {
  const rows = await findBackfillCandidates(readItems(home, { status: 'open' }), { fetchPr });
  if (apply) for (const row of rows.filter(row => row.apply)) updateItem(home, row.id, item => {
    if (!item.text.includes(row.url)) item.text = `${item.text}${item.text.endsWith('\n') ? '' : '\n'}PR: ${row.url}\n`;
  });
  return { rows, apply, candidates: rows.filter(row => row.apply).length, skipped: rows.filter(row => !row.apply).length };
}

export function formatBackfillResult(result) {
  const lines = ['ID | 現在のタイトル | 推定した完全URL | PR state | 判定根拠', '--- | --- | --- | --- | ---'];
  for (const row of result.rows) lines.push(`${row.id} | ${row.title.replace(/\|/g, '\\|')} | ${row.url} | ${row.state} | ${row.reason.replace(/\|/g, '\\|')}`);
  lines.push(`kim-inbox PR URL backfill ${result.apply ? '(apply)' : '(dry-run)'}: 補完候補 ${result.candidates}件 / skip ${result.skipped}件`);
  return lines.join('\n');
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
  if (args.includes('--help') || args.includes('-h')) {
    (io.stdout || console.log)(USAGE);
    return 0;
  }
  const json = args.includes('--json');
  try {
    if (args.includes('--backfill-url')) {
      const result = await runBackfill({ ...io, apply: args.includes('--apply') });
      (io.stdout || console.log)(json ? JSON.stringify(result, null, 2) : formatBackfillResult(result));
      return 0;
    }
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
