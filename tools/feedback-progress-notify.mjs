#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_REPO_MAP, parseRepoMap, parseHostMap, parseEnvText, runGh } from './feedback-to-issues.mjs';
import { pickRecipient } from './feedback-done-notify.mjs';
import { getDiscordMembers } from './discord-member-directory.mjs';
import { sendDiscordDm } from './feedback-nag.mjs';
import { isEntry } from './is-entry.mjs';

const KIM_USER_ID = '715210673642012733';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const messages = {
  answered: '調査が終わり、確認したいことがあります。リンク先をご確認ください。',
  pr_open: '修正を作成しました。承認をお待ちしています。',
  pr_blocked: '修正を作成しましたが自動テストで問題が出ています。修正中です。',
  stalled: 'まだ対応中です。遅れています。',
};

function userHome() {
  return process.env.ORGIAST_HOME || process.env.USERPROFILE || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
}
const defaultIo = {
  read: (file) => fs.readFileSync(file, 'utf8'),
  write: (file, text) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, text, 'utf8');
    fs.renameSync(temp, file);
  },
  stdout: (text) => console.log(text), stderr: (text) => console.error(text), now: () => new Date(),
};
function optionalText(file, io) {
  try { return io.read(file); } catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
}
function readJson(file, fallback, io) {
  const text = optionalText(file, io);
  return text ? JSON.parse(text) : fallback;
}
function timestamp(value) { return new Date(value || 0).getTime(); }

// GitHub の投稿者は人間と自動セッションで共用されるため、login だけで Claude と断定しない。
// 専用マーカー、または信頼された投稿者の調査・質問の組合せで判定する。
export function waitingForReply(comments = []) {
  const latest = [...comments].sort((a, b) => timestamp(b.created_at || b.createdAt) - timestamp(a.created_at || a.createdAt))[0];
  const body = latest?.body || '';
  if (/<!-- feedback-reply:/.test(body)) return false;
  if (/<!-- feedback-question -->/.test(body)) return true;
  const trusted = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(latest?.author_association || latest?.authorAssociation)
    || /claude/i.test(latest?.user?.login || latest?.author?.login || '');
  // PR を提示した進捗コメント内の残課題は、新しい質問待ちへの遷移とは扱わない。
  return trusted && !/(?:\bPR\s*#\d+|\/pull\/\d+)/i.test(body)
    && /調査|実査|Claude/i.test(body) && /[?？]|教えてください|確認したい|返信待ち/.test(body);
}

export function selectProgress(issue, prs = [], now = new Date()) {
  if (String(issue.state).toUpperCase() !== 'OPEN') return null;
  if (waitingForReply(issue.comments)) return { state: 'answered', url: issue.html_url || issue.url };
  const pr = prs.filter((entry) => entry.state === 'OPEN').sort((a, b) => timestamp(b.createdAt) - timestamp(a.createdAt))[0];
  if (pr) {
    const checks = pr.statusCheckRollup || [];
    const states = checks.map((check) => String(check.conclusion || check.state || check.status || '').toUpperCase());
    if (states.some((state) => ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(state))) {
      return { state: 'pr_blocked', url: pr.url };
    }
    if (states.some((state) => state === 'SUCCESS') && states.every((state) => ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(state))) {
      return { state: 'pr_open', url: pr.url };
    }
  }
  const updated = Math.max(timestamp(issue.updated_at || issue.updatedAt), ...prs.map((entry) => timestamp(entry.updatedAt || entry.createdAt)));
  if (updated > 0 && now.getTime() - updated >= 7 * 86400000) return { state: 'stalled', url: issue.html_url || issue.url };
  return null;
}

function githubJson(args, gh) {
  const result = gh(args, { timeout: 60000 });
  if (result.error || result.status !== 0) throw new Error(`GitHub 取得失敗: ${result.error?.message || result.stderr?.trim() || result.status}`);
  return JSON.parse(result.stdout);
}
function pages(endpoint, gh) {
  return githubJson(['api', '--paginate', '--slurp', endpoint], gh).flat();
}
export function loadProgressIssue(item, gh = runGh) {
  const endpoint = `repos/${item.repo}/issues/${item.number}`;
  const issue = githubJson(['api', endpoint], gh);
  if (issue.state !== 'open') return { issue, prs: [] };
  issue.comments = pages(`${endpoint}/comments?per_page=100`, gh);
  const references = pages(`${endpoint}/timeline?per_page=100`, gh)
    .filter((event) => event.event === 'cross-referenced' && event.source?.issue?.pull_request)
    .map((event) => event.source.issue.pull_request.html_url);
  const prs = [...new Set(references)].map((url) => githubJson([
    'pr', 'view', url, '--json', 'state,url,createdAt,updatedAt,statusCheckRollup',
  ], gh));
  return { issue, prs };
}

export async function runProgressNotify({ args = process.argv.slice(2), home = userHome(), io = defaultIo,
  fetchImpl = fetch, sendDm = sendDiscordDm, gh = runGh, loadIssue = loadProgressIssue, getMembers = getDiscordMembers } = {}) {
  io = { ...defaultIo, ...io };
  const dryRun = args.includes('--dry-run');
  const report = { ok: true, dryRun, items: [], errors: [] };
  const warn = (context, error) => {
    report.ok = false;
    const message = `${context}: ${error.message || error}`;
    report.errors.push(message);
    io.stderr(`feedback-progress-notify: ${message}`);
  };
  try {
    const dir = path.join(home, '.claude');
    const ledger = readJson(path.join(dir, 'feedback-issue-ledger.json'), { items: [] }, io);
    if (!Array.isArray(ledger.items)) throw new Error('Issue 台帳の items が配列ではありません');
    const progressFile = path.join(dir, 'feedback-progress-ledger.json');
    const progress = readJson(progressFile, { version: 1, items: {} }, io);
    if (progress.version !== 1 || !progress.items || Array.isArray(progress.items) || typeof progress.items !== 'object') throw new Error('中間通知台帳の形式が不正です');
    const env = parseEnvText(optionalText(path.join(dir, 'feedback-relay.env'), io));
    const repos = new Set([...Object.values(DEFAULT_REPO_MAP),
      ...Object.values(parseRepoMap(process.env.FEEDBACK_REPO_MAP || env.FEEDBACK_REPO_MAP)),
      ...Object.values(parseHostMap(process.env.FEEDBACK_HOST_MAP || env.FEEDBACK_HOST_MAP)),
      ...ledger.items.map((item) => item.repo)].filter((repo) => REPO.test(repo)));
    const candidates = new Map();
    for (const item of ledger.items) {
      if (REPO.test(item.repo) && Number.isInteger(item.number) && item.number > 0) candidates.set(`${item.repo}#${item.number}`, item);
    }
    for (const repo of repos) {
      try {
        // REST のページ走査で search の件数上限による取りこぼしも避ける。
        for (const issue of pages(`repos/${repo}/issues?state=open&labels=feedback&per_page=100`, gh)) {
          if (issue.pull_request) continue;
          const key = `${repo}#${issue.number}`;
          if (!candidates.has(key)) candidates.set(key, { repo, number: issue.number });
        }
      } catch (error) { warn(repo, error); }
    }
    for (const [key, item] of candidates) {
      try {
        const { issue, prs } = await loadIssue(item, gh);
        if (String(issue.state).toUpperCase() !== 'OPEN') continue;
        const selected = selectProgress(issue, prs, io.now());
        const row = { key, title: issue.title || item.title || 'フォームからのご報告', state: selected?.state || null, url: selected?.url || issue.html_url || issue.url, sent: false };
        report.items.push(row);
        const submitter = item.submitter || issue.body?.match(/^\s*提出者[:：]\s*(.+)$/m)?.[1]?.trim() || '';
        const identity = { ...item, submitter };
        let recipient = pickRecipient(identity, []);
        if (!recipient && submitter) {
          try { recipient = pickRecipient(identity, await getMembers({ query: submitter, home, fetchImpl, persistCache: !dryRun })); }
          catch (error) { warn(`${key} 名簿取得`, error); }
        }
        row.escalated = !recipient;
        row.recipient = recipient?.label || 'kim';
        const last = progress.items[key];
        // エスカレーションと依頼主への通知は別配送。名前解決後は同じ状態でも依頼主へ届ける。
        const delivery = recipient?.id || 'unresolved';
        if (!selected && recipient) continue;
        if (last && last.lastState === row.state && (last.delivery === delivery || (!last.delivery && recipient))) { row.skipped = 'unchanged'; continue; }
        row.content = recipient
          ? `【${row.title.slice(0, 150)}】\n${messages[row.state]}\n${row.url}`
          : `この Issue の依頼主が特定できません。\n【${row.title.slice(0, 150)}】\n${selected ? messages[row.state] + '\n' : ''}${issue.html_url || issue.url}${selected && row.url !== (issue.html_url || issue.url) ? '\n' + row.url : ''}`;
        if (dryRun) continue;
        const token = process.env.DISCORD_BOT_TOKEN?.trim() || optionalText(path.join(dir, 'orgiast-discord-bot-token.txt'), io).trim();
        if (!token) throw new Error('Discord Bot トークンが見つかりません');
        await sendDm({ token, userId: recipient?.id || KIM_USER_ID, content: row.content, fetchImpl });
        row.sent = true;
        progress.items[key] = { lastState: row.state, notifiedAt: io.now().toISOString(), delivery };
        io.write(progressFile, `${JSON.stringify(progress, null, 2)}\n`);
      } catch (error) { warn(key, error); }
    }
  } catch (error) { warn('処理失敗', error); }
  io.stdout(args.includes('--json') ? JSON.stringify(report) : report.items.map((item) => `${item.key} ${item.state || '対応中'} ${item.skipped || (item.sent ? '通知済み' : '未送信')}\n${item.content || item.url}`).join('\n') || 'feedback-progress-notify: 対象なし');
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = await runProgressNotify();
