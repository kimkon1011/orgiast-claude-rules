#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_REPO_MAP, parseRepoMap, parseHostMap, parseEnvText, runGh } from './feedback-to-issues.mjs';
import { pickRecipient } from './feedback-done-notify.mjs';
import { getDiscordMembers, normalizeName } from './discord-member-directory.mjs';
import { sendDiscordDm } from './feedback-nag.mjs';
import { isEntry } from './is-entry.mjs';

const KIM_USER_ID = '715210673642012733';
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const messages = {
  answered: '調査が終わり、確認したいことがあります。リンク先をご確認ください。',
  pr_open: '修正を作成しました。承認をお待ちしています。',
  pr_blocked: '修正を作成しましたが自動テストで問題が出ています。修正中です。',
  stalled: 'まだ対応中です。',
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
    return { state: 'pr_open', url: pr.url };
  }
  return { state: 'stalled', url: issue.html_url || issue.url };
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
  // Paginate within the issue repository; cross-repository timeline mentions are not links.
  const candidates = githubJson(['api', '--paginate', '--slurp',
    `repos/${item.repo}/pulls?state=open&per_page=100`], gh).flat();
  const linked = candidates.filter((pr) => {
    const prefix = `https://github.com/${item.repo}/pull/`;
    if (!(pr.html_url || pr.url || '').startsWith(prefix)) return false;
    const text = `${pr.title || ''}\n${pr.body || ''}`;
    // Remove qualified references before testing bare #N, so other/repo#N cannot match.
    const localText = text.replace(/https:\/\/github\.com\/[^\s)]+/g, '')
      .replace(/[\w.-]+\/[\w.-]+#\d+/g, '');
    return new RegExp(`(^|[^\\w/#])#${item.number}(?!\\d)`).test(localText)
      || [...text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)\b/g)]
        .some((match) => match[1] === item.repo && Number(match[2]) === item.number)
      || new RegExp(`(?:^|[/_-])issue[-_]${item.number}(?:$|[/_-])`, 'i').test(pr.head?.ref || '');
  });
  const prs = linked.map((pr) => githubJson(['pr', 'view', String(pr.number), '--repo', item.repo,
    '--json', 'state,url,createdAt,updatedAt,statusCheckRollup'], gh));
  return { issue, prs };
}

export function submitterSources(item, body = '') {
  body = String(body || '');
  let marker = {};
  try { marker = JSON.parse(body.match(/<!--\s*feedback-submitter:\s*(.*?)\s*-->/s)?.[1] || '{}'); } catch {}
  const labels = [...body.matchAll(/^\s*(?:提出者|報告者|送信元|依頼者)[:：]\s*(.+)$/gm)]
    .map((match) => ({ submitter: match[1].trim() }));
  const headings = [...body.matchAll(/^\s*#{1,6}\s*(?:要望|不具合|報告)[（(]\s*([^/\n]+?)\s*[/／]\s*\d{4}-\d{2}-\d{2}[^\n]*[）)]\s*$/gm)]
    .map((match) => ({ submitter: match[1].trim() }));
  return [item, marker, ...labels, ...headings].filter((source) => source && typeof source === 'object');
}

// Only explicit issue links or an exact title + body + application URL establish provenance.
// A timestamp or a unique title alone cannot establish who owns an issue.
export function matchFeedbackSource(issue, items = []) {
  const body = String(issue.body || '');
  const sourceUrl = body.match(/^提出元URL[:：]\s*(\S+)\s*$/m)?.[1];
  const title = String(issue.title || '').replace(/^\[(?:要望|不具合)\]\s*/, '');
  const detail = body.split(/\n\s*提出者[:：]/)[0].trim().replace(/\r\n/g, '\n');
  const matches = items.filter((item) => {
    const explicit = item.issue_url || item.github_issue_url;
    if (explicit) return explicit === (issue.html_url || issue.url);
    return sourceUrl && item.source_url === sourceUrl && item.title === title
      && detail && !title.includes('�') && !detail.includes('�')
      && String(item.body || '').trim().replace(/\r\n/g, '\n') === detail;
  });
  return matches.length === 1 ? matches[0] : null;
}

export async function loadFeedbackSource({ home, io, fetchImpl }) {
  const env = parseEnvText(optionalText(path.join(home, '.claude', 'booth-feedback.env'), io));
  if (!env.BOOTH_FEEDBACK_URL || !env.BOOTH_FEEDBACK_TOKEN) return { items: [], unavailable: 'feedback API 未設定' };
  const url = new URL(env.BOOTH_FEEDBACK_URL);
  url.searchParams.set('action', 'feedback');
  url.searchParams.set('token', env.BOOTH_FEEDBACK_TOKEN);
  const response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`feedback API HTTP ${response.status}`);
  const data = await response.json();
  if (!data.ok || !Array.isArray(data.items)) throw new Error('feedback API の応答形式が不正です');
  return data;
}

function exactMembers(query, members) {
  const value = String(query || '').trim();
  if (!value || value === '不明') return [];
  // kim is the configured owner alias, not a prefix search (Kimi is another member).
  const candidates = (members || []).map((member) => value.toLowerCase() === 'kim' && String(member.id) === KIM_USER_ID
    ? { ...member, nick: 'kim' } : member);
  return candidates.filter((member) => value.includes('@')
    ? member.emails?.some((email) => email.toLowerCase() === value.toLowerCase())
    : [member.nick, member.global_name, member.username].some((name) => name && normalizeName(name) === normalizeName(value)));
}

export function sourceIdentity(source) {
  if (!source) return {};
  // source is commonly a screen name, so it is deliberately not treated as a person.
  return { submitter: source.submitter || source.email || source.name || '',
    submitter_discord_id: source.submitter_discord_id || source.discord_id || '' };
}

export function displayTitle(issue, item) {
  const title = issue.title || item.title || 'フォームからのご報告';
  // U+FFFD already in GitHub cannot be decoded back. Use an explicit, non-invented label.
  return title.includes('\uFFFD') ? `フォームからのご報告 #${issue.number}（原題の文字化けあり）` : title;
}

export async function runProgressNotify({ args = process.argv.slice(2), home = userHome(), io = defaultIo,
  fetchImpl = fetch, sendDm = sendDiscordDm, gh = runGh, loadIssue = loadProgressIssue, getMembers = getDiscordMembers, loadSource = loadFeedbackSource } = {}) {
  io = { ...defaultIo, ...io };
  const dryRun = args.includes('--dry-run');
  const backfill = args.includes('--backfill');
  const report = { ok: true, dryRun, backfill, items: [], errors: [] };
  const warn = (context, error) => {
    report.ok = false;
    const message = `${context}: ${error.message || error}`;
    report.errors.push(message);
    io.stderr(`feedback-progress-notify: ${message}`);
  };
  try {
    const dir = path.join(home, '.claude');
    let source = { items: [], unavailable: 'feedback API 取得失敗' };
    try { source = await loadSource({ home, io, fetchImpl }); }
    catch { warn('一次ソース', new Error('feedback API 取得失敗（URL・トークンは非表示）')); }
    report.source = { count: source.items.length, sheetUrl: source.sheetUrl || '', unavailable: source.unavailable || null,
      coverage: 'API が返した items のみ。全履歴の取得を保証しない' };
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
        const row = { key, title: displayTitle(issue, item), state: selected?.state || null, url: selected?.url || issue.html_url || issue.url, sent: false };
        report.items.push(row);
        row.checks = prs.filter((pr) => pr.url === row.url).flatMap((pr) => pr.statusCheckRollup || [])
          .map((check) => ({ name: check.name || check.context || '', state: check.conclusion || check.state || check.status || 'PENDING' }));
        let recipient = null, submitter = '';
        const attemptedSubmitters = new Set();
        const matchedSource = matchFeedbackSource(issue, source.items);
        const identities = [...submitterSources(item, issue.body), sourceIdentity(matchedSource)];
        row.sourceEvidence = matchedSource ? { matched: true, key: matchedSource.key, rowNumber: matchedSource.rowNumber }
          : { matched: false, reason: source.unavailable || 'API が返した items に厳密一致する報告なし' };
        for (const identity of identities) {
          recipient = pickRecipient(identity, []);
          if (!recipient && identity.submitter && !attemptedSubmitters.has(identity.submitter)) {
            attemptedSubmitters.add(identity.submitter);
            try { recipient = pickRecipient(identity, exactMembers(identity.submitter, await getMembers({ query: identity.submitter, home, fetchImpl, persistCache: !dryRun }))); }
            catch (error) { warn(`${key} 名簿取得`, error); }
          }
          if (recipient) { submitter = identity.submitter || item.submitter || ''; break; }
        }
        row.recipientId = recipient?.id || KIM_USER_ID;
        row.submitter = submitter || submitterSources(item, issue.body).find((source) => source.submitter)?.submitter || '';
        row.titleFallback = Boolean(issue.title?.includes('\uFFFD'));
        if (recipient && item.submitter_discord_id !== recipient.id) {
          row.backfill = { submitter, submitter_discord_id: recipient.id, submitter_discord_label: recipient.label };
          if (backfill && !dryRun) {
            // Re-read to preserve entries appended by the intake since this run started.
            const file = path.join(dir, 'feedback-issue-ledger.json');
            const fresh = readJson(file, { items: [] }, io);
            if (!Array.isArray(fresh.items)) throw new Error('Issue 台帳の items が配列ではありません');
            const existing = fresh.items.find((entry) => entry.repo === item.repo && entry.number === item.number);
            if (existing) Object.assign(existing, row.backfill);
            else fresh.items.push({ ...item, ...row.backfill });
            io.write(file, `${JSON.stringify(fresh, null, 2)}\n`);
          }
        }
        row.resolution = recipient ? (recipient.id === KIM_USER_ID ? 'owner_is_kim' : 'resolved') : 'escalated';
        row.escalated = !recipient;
        if (!recipient) row.unresolvedReason = identities.some((entry) => entry.submitter && entry.submitter !== '不明')
          ? '本文・一次ソースの識別情報から Discord メンバーを一意に解決できません'
          : '本文・照合できた一次ソースに依頼主の識別情報がありません';
        row.recipient = recipient?.label || 'kim';
        const last = progress.items[key];
        // エスカレーションと依頼主への通知は別配送。名前解決後は同じ状態でも依頼主へ届ける。
        const delivery = recipient?.id || 'unresolved';
        if (!selected && recipient) continue;
        if (last && last.lastState === row.state && (last.delivery === delivery || (!last.delivery && recipient))) { row.skipped = 'unchanged'; continue; }
        row.content = recipient
          ? `【${row.title.slice(0, 150)}】\n${messages[row.state]}\n${row.url}`
          : `この報告の依頼主が特定できません。元シートの行を確認してください。\n【${row.title.slice(0, 150)}】\n${selected ? messages[row.state] + '\n' : ''}${issue.html_url || issue.url}${selected && row.url !== (issue.html_url || issue.url) ? '\n' + row.url : ''}`;
        if (!recipient && source.sheetUrl) row.content += `\n照合元シート（該当行は未特定）: ${source.sheetUrl}`;
        // Explicit maintenance mode never sends DMs or advances the notification ledger.
        if (dryRun || backfill) continue;
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
