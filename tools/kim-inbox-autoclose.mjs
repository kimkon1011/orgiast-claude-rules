#!/usr/bin/env node
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isEntry } from './is-entry.mjs';
import { answerItem, listItems, updateInboxItem } from './kim-inbox.mjs';

const execFileAsync = promisify(execFile);
export const PR_URL_RE = /https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/g;

// Allowlisted sources for judgment-free automatic notifications (A-type).
// Matches exactly on item.source. Add new sources here when they join the known set.
//
// Sources intentionally excluded — do NOT re-add without verifying each ask
// is truly judgment-free against real inbox data:
//
// - login-health: 本文「🔑 ログイン切れ検知: ai-lane:gemini / 状態: gemini 停止 (billing) / 直し方: node tools/lane-doctor.mjs --probe」
//   → kim の入金・再ログインが必要な通知。自動クローズ禁止。
//
// - auto-progress-start-expired: 本文「セッション 15e481c1 / 対象: リーダー報酬 単価行自動追加の承認待ち」
//   → kim の承認待ちセッション。自動クローズ禁止。
//
// - auto-progress-periodic: 定期進捗報告だが「確認結果: 未達」を含み追跡が必要。ask は 1 件のみ。
//   → C 寄り。自動クローズから外す。
//
// - auto-progress-heartbeat: open ask に実例が 0 件（2026-11-24 時点）。A と確認できていない。
//   → 確認できていないものは入れない。
export const AUTO_CLOSE_SOURCES = new Set([
  'auto-progress-done',
]);

// Allowlisted text patterns for A-type detection. Used as a secondary check
// when the source is not in AUTO_CLOSE_SOURCES but the text clearly matches a
// known notification pattern. Each regex must be specific enough to avoid
// false positives on judgment-requesting items.
//
// login-health pattern (/^🔑\s*ログイン切れ検知:/) was removed because the
// notification requires kim to take action (payment / re-login). See the
// source-blocking comment above for the real text that proves this.
export const AUTO_CLOSE_TEXT_PATTERNS = [
  /^✅\s*check\s+達成:/,
  /^✅\s*自動進行が完了しました/,
  /^📋\s*未通知だった自動進行の完了一覧/,
];
const APPROVAL_REQUEST_PATTERNS = [
  /してよいか/,
  /実行可否/,
  /可否/,
  /承認/,
  /どちらにする/,
  /判断してください/,
  /やってよい/,
  /進めてよい/,
];
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

export function findAutoCloseCandidatesBySource(items) {
  const candidates = [];
  for (const item of items) {
    if (item.kind !== 'ask' || item.status !== 'open') continue;
    const source = item.source || '';
    const text = item.text || '';
    // Source-based allowlist (exact match). This is the primary detection path.
    if (AUTO_CLOSE_SOURCES.has(source)) {
      candidates.push({ id: item.id, source, reason: `source=${source}`, text: text.slice(0, 80) });
      continue;
    }
    // Text pattern allowlist (secondary). Only checked when source didn't match.
    for (const pattern of AUTO_CLOSE_TEXT_PATTERNS) {
      if (pattern.test(text)) {
        candidates.push({ id: item.id, source, reason: `text-pattern=${pattern.source}`, text: text.slice(0, 80) });
        break;
      }
    }
  }
  return candidates;
}

export async function findAutocloseCandidates(items, { fetchState = fetchPullRequestState } = {}) {
  const cache = new Map();
  const failures = [];
  const skipped = [];
  const candidates = [];
  let approvalRequestExcludedCount = 0;

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
    const text = item.text || '';
    const isKnownCompletionNotification = AUTO_CLOSE_TEXT_PATTERNS.some(pattern => pattern.test(text));
    if (!isKnownCompletionNotification && APPROVAL_REQUEST_PATTERNS.some(pattern => pattern.test(text))) {
      approvalRequestExcludedCount++;
      skipped.push({ id: item.id, reason: '承認待ち', prs: states });
      continue;
    }
    candidates.push({ id: item.id, prs: states });
  }
  return { candidates, skipped, failures, fetchedPrCount: cache.size, approvalRequestExcludedCount };
}

function closeMessage(prs) {
  return prs.map(pr => {
    const at = pr.mergedAt || pr.closedAt || '日時不明';
    return `PR #${pr.number} は ${pr.state}（${at}）のため自動クローズ。判断は不要です。`;
  }).join('\n');
}

function sourceCloseMessage(candidate) {
  return `自動通知のため自動クローズしました（${candidate.reason}）`;
}

export async function runAutoclose({
  home = process.env.ORGIAST_HOME || os.homedir(), apply = false,
  fetchState = fetchPullRequestState, readItems = listItems, answer = answerItem,
} = {}) {
  const items = readItems(home, { status: 'open' });
  const prResult = await findAutocloseCandidates(items, { fetchState });
  const sourceCandidates = findAutoCloseCandidatesBySource(items);
  const closed = [];
  if (apply) {
    for (const candidate of prResult.candidates) {
      answer(home, candidate.id, closeMessage(candidate.prs), 'kim-inbox-autoclose');
      closed.push(candidate.id);
    }
    for (const candidate of sourceCandidates) {
      answer(home, candidate.id, sourceCloseMessage(candidate), 'kim-inbox-autoclose');
      closed.push(candidate.id);
    }
  }
  return { ...prResult, apply, closed, sourceCandidates };
}

export function formatResult(result, { json = false } = {}) {
  if (json) return JSON.stringify(result, null, 2);
  const lines = [];
  for (const row of result.candidates) {
    const prs = row.prs.map(pr => `#${pr.number} ${pr.state} ${pr.mergedAt || pr.closedAt || '日時不明'}`).join(', ');
    lines.push(`${row.id} ${prs}`);
  }
  for (const row of result.sourceCandidates || []) {
    lines.push(`${row.id} [自動通知] ${row.reason} | ${row.text}`);
  }
  lines.push(`kim-inbox autoclose ${result.apply ? '(apply)' : '(dry-run)'}: PR対象 ${result.candidates.length}件 / 自動通知 ${(result.sourceCandidates || []).length}件 / PR取得 ${result.fetchedPrCount}件 / 取得失敗 ${result.failures.length}件 / 承認待ちのため除外 ${result.approvalRequestExcludedCount || 0}件`);
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
