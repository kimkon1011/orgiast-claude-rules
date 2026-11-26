#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolveFleetLabel } from './lib/fleet-label.mjs';
import { resolveOwner } from './lib/fleet-owner.mjs';
import { isKimOperated } from './lib/kim-operated.mjs';
import { redactSecrets } from './webhook-health.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
import { displayPcNames } from './lib/pc-display.mjs';
import { formatInboxBrief, relayDue, recordInjection, recordPromptAnswers, recordNaturalLanguageAnswers, interactiveInboxSession, groupInboxItems, readRelayState, writeRelayState } from './lib/kim-inbox-relay-state.mjs';
import { readLedger, ledgerFile, OPEN_STATUSES } from './auto-progress-ledger.mjs';
import { matchesRow, parseEscalation, syncEscalationAnswer } from './lib/escalation-answer-sync.mjs';
import { looksLikeApprovalRequest } from './lib/kim-inbox-kind.mjs';
import { isPullRequestMergeApprovalRequest, MERGE_HANDOFF_REJECTION_MESSAGE } from './lib/kim-inbox-merge-handoff.mjs';
const exec = promisify(execFile);
const execGh = promisify(execFile);
const PR_REF_RE = /PR\s*#(\d+)/gi;
const PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/gi;
// Separate regex without global flag for boolean check (global .test() mutates lastIndex).
const PR_URL_BOOL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;
export function hasFullPrUrl(text) {
  return PR_URL_BOOL.test(text);
}
export async function resolvePrRefs(text, { execImpl = execGh, stderr = console.error } = {}) {
  const matches = [...text.matchAll(PR_REF_RE)];
  if (!matches.length) return text;
  // Exclude matches that already have a full URL nearby (within 100 chars)
  const candidates = matches.filter(m => {
    const idx = m.index;
    const slice = text.slice(Math.max(0, idx - 80), idx + 120);
    return !PR_URL_RE.test(slice);
  });
  if (!candidates.length) return text;
  const unique = [...new Set(candidates.map(m => m[1]))];
  let result = text;
  for (const num of unique) {
    try {
      const { stdout } = await execImpl('gh', ['pr', 'view', num, '--json', 'url'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true,
      });
      const url = JSON.parse(stdout).url;
      if (url && typeof url === 'string' && url.startsWith('https://github.com/')) {
        result = result.replace(new RegExp(`PR\\s*#${num}(?!\\s*\\(https?:)`, 'g'), `PR #${num} (${url})`);
        result = result.replace(new RegExp(`PR#${num}(?!\\s*\\(https?:)`, 'g'), `PR #${num} (${url})`);
      }
    } catch (error) {
      stderr(`[kim-inbox] PR #${num} のURL解決に失敗しました: ${error.message?.slice(0, 100) || String(error).slice(0, 100)}`);
    }
  }
  return result;
}

const directory = home => path.join(home, '.claude/kim-inbox');
const archiveDirectory = home => path.join(directory(home), '.archive');
const archiveIndex = home => path.join(archiveDirectory(home), 'index.jsonl');
const DAY_MS = 86_400_000;
const clean = value => redactSecrets(String(value ?? '')).slice(0, 4000);
const GITHUB_PR_URL_RE = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/g;
const SHORT_PR_RE = /#(\d{1,6})(?!\w)/g;

export function parseGitHubRepo(remote) {
  const match = String(remote ?? '').trim().match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function appendPullRequestUrls(text, repo) {
  const original = String(text ?? '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? '')) return original;
  const existing = new Set([...original.matchAll(GITHUB_PR_URL_RE)].map(match => Number(match[1])));
  const numbers = [];
  for (const match of original.matchAll(SHORT_PR_RE)) {
    const digits = match[1];
    if (digits.length === 6) continue;
    const number = Number(digits);
    if (!existing.has(number) && !numbers.includes(number)) numbers.push(number);
  }
  if (!numbers.length) return original;
  const suffix = numbers.map(number => `PR: https://github.com/${repo}/pull/${number}`).join('\n');
  return `${original}${original.endsWith('\n') || !original ? '' : '\n'}${suffix}\n`;
}

export async function enrichPullRequestUrls(text, { env = process.env, cwd = process.cwd(), execImpl = exec } = {}) {
  let repo = /^[\w.-]+\/[\w.-]+$/.test(env.KIM_INBOX_PR_REPO ?? '') ? env.KIM_INBOX_PR_REPO : null;
  if (!repo) {
    try {
      const { stdout } = await execImpl('git', ['remote', 'get-url', 'origin'], { cwd, encoding: 'utf8', windowsHide: true });
      repo = parseGitHubRepo(stdout);
    } catch { /* Preserve the original body when the repository cannot be resolved. */ }
  }
  return appendPullRequestUrls(text, repo);
}
// Redaction/truncation is lossy and must not collapse distinct producer identities.
// Hash only affected keys; short chunks keep the opaque digest stable through spooling.
export function inboxDedupeKey(value) {
  const raw = String(value ?? '');
  return clean(raw) === raw ? raw : `dedupe-sha256:${createHash('sha256').update(raw).digest('hex').match(/.{16}/g).join('-')}`;
}
const validId = id => /^ki-\d{14}-[a-f0-9]{4}$/.test(id);
export const CONTEXT_LIMIT = 1800;
// 古いロック(EPERM/pid再利用)を mtime で回収。既定5分、環境変数で上書き可。
const STALE_LOCK_MS = Number(process.env.KIM_INBOX_STALE_LOCK_MS) || 300_000;
// ロックが古いとき削除ではなく .stale-<epoch> へ rename して証跡を残す。
function renameStaleLock(lock) {
  try {
    const stale = `${lock}.stale-${Date.now()}`;
    fs.renameSync(lock, stale);
    console.error(`kim-inbox: 古いロックを rename しました ${lock} -> ${stale}`);
    return true;
  } catch { return false; }
}
// mtime と（必要な場合）PID 存活確認でロックを回収できるか判定する。
function tryReclaimLock(lock) {
  try {
    const stat = fs.statSync(lock);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) return renameStaleLock(lock);
    // mtime が新しい — PID が消えていたら回収
    try {
      const pid = Number(fs.readFileSync(lock, 'utf8'));
      if (pid > 0) try { process.kill(pid, 0); } catch (e) {
        if (e.code === 'ESRCH') return renameStaleLock(lock);
        // EPERM: PID が保護済み/再利用 — mtime が新しいので待つ
      }
    } catch { /* 読めない/不正なPID */ }
  } catch (statErr) { if (statErr.code === 'ENOENT') return true; } // 直前に解放済み
  return false;
}
// kim 本人が座る席（kim-PC、所有者が kim のPC、kim が操作する nishi@/cr@/seisaku-team@ 等の
// アカウント = lib/kim-operated.mjs）では、kim-PC へ転送せずその場のセッションで回収する（2026-10-28 kim）。
export function isKimSeat(home) {
  const label = resolveFleetLabel(home, { hostname: os.hostname() });
  return label === 'kim-PC' || isKimOperated(home) || resolveOwner({ home, label }).toLowerCase() === 'kim@orgiast.jp';
}
function save(home, item) {
  const file = path.join(directory(home), `${item.id}.json`);
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try { fs.writeFileSync(temp, JSON.stringify(item, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(temp, file); }
  finally { fs.rmSync(temp, { force: true }); }
}
// 同じ項目の回答・表示更新を直列化し、古い表示更新が回答を上書きしない。
function acquireInboxLock(home, key, waitMs = 60_000) {
  fs.mkdirSync(directory(home), { recursive: true });
  const lock = path.join(directory(home), `${key}.lock`);
  let fd;
  const deadline = performance.now() + waitMs;
  let delay = 10;
  for (;;) {
    try { fd = fs.openSync(lock, 'wx', 0o600); fs.writeFileSync(fd, String(process.pid)); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (tryReclaimLock(lock)) continue;
      const remaining = deadline - performance.now();
      if (remaining <= 0) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(delay, remaining));
      delay = Math.min(delay * 2, 500);
    }
  }
  if (fd === undefined) throw new Error('kim-inbox: 台帳が使用中です');
  return () => { fs.closeSync(fd); fs.unlinkSync(lock); };
}
function locked(home, key, fn, waitMs) {
  const release = acquireInboxLock(home, key, waitMs);
  try { return fn(); } finally { release(); }
}
function update(home, id, fn) {
  if (!validId(id)) throw new Error('kim-inbox: ID が不正です');
  return locked(home, id, () => {
    const file = path.join(directory(home), `${id}.json`);
    const archived = !fs.existsSync(file) && archivedItemPath(home, id);
    const item = JSON.parse(fs.readFileSync(archived || file, 'utf8'));
    fn(item);
    // Bring a record back before updating it. A live file takes precedence over the index.
    if (archived) fs.renameSync(archived, file);
    save(home, item);
    return item;
  });
}
export { update as updateInboxItem };
export const isHighInfo = item => item.kind === 'info' && (item.priority === 'high' || /^auto-progress-(done|heartbeat)$/.test(item.source) || /完了|進捗|進んでいる|承認待ち|✅|未達|確認エラー|判断待ち|自動進行|まとめ/.test(item.text));
const hasWorkId = item => /作業ID:\s*[a-f0-9]{8}(?![a-f0-9])/i.test(item.text);
const newestFirst = (a, b) => (b.lastAt || b.createdAt).localeCompare(a.lastAt || a.createdAt) || b.id.localeCompare(a.id);
export const normalizeInboxText = text => String(text ?? '')
  .normalize('NFKC')
  .trim()
  .replace(/^(?:【[^】]*】\s*)+/, '')
  .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b|\b\d{1,2}\/\d{1,2}\b|\d{1,2}月\d{1,2}日/g, '')
  .replace(/\d+(日|件|時間)/g, 'N$1')
  .replace(/(?:\bkim\b|キムさん|キム|金さん|金功勇)\s*/gi, 'KIM')
  .replace(/[\p{Extended_Pictographic}\uFE0E\uFE0F\u200D]/gu, '')
  .replace(/\b(?:0x[a-f0-9]+|[a-f0-9]{12,})\b/gi, '')
  .replace(/\s+/g, ' ')
  .trim()
  .toLowerCase();
const explicitQuestion = text => /^(?:【要対応・kim の判断待ち[^】]*】|【早めの対応が必要[^】]*】)/.test(text)
  || /(?:^|\n)(?:あなたの返事待ち|kim (?:の判断待ち|がすること)|判断してほしいこと)[:：]/i.test(text)
  || /判断待ち|判断してください|決めて(?:ください)?|選んで(?:ください)?|どれにしますか|どちらにしますか|承認|可否|返事をください|返事の例/.test(text)
  || /(?:A\s*[\/／]\s*B|AかB|A・B).{0,80}(?:返答|回答|選択|選ん|判断)/is.test(text);
export function isNonQuestionAsk(body) {
  const text = String(body ?? '').trim();
  if (!text || explicitQuestion(text)) return false;
  return /^✅\s*check 達成:/.test(text)
    || (text.includes('セッションの目的:') && text.includes('作業ID:'))
    || (text.includes('gate pc=') && text.includes('verdict='));
}
function nonQuestionPattern(body) {
  const text = String(body ?? '').trim();
  if (/^✅\s*check 達成:/.test(text)) return 'check-achieved';
  if (text.includes('セッションの目的:') && text.includes('作業ID:')) return 'session-status';
  if (text.includes('gate pc=') && text.includes('verdict=')) return 'gate-diagnostic';
  return 'unknown';
}
const contentDedupeKey = item => `${item.kind}\n${normalizeInboxText(item.text)}`;
const legacyInfoKey = text => text.replace(/^【[^\r\n]*】[^\S\r\n]*(?:\r?\n|$)/, '')
  .replace(/\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/g, '#')
  .replace(/\b(?:0x[a-f0-9]+|[a-f0-9]{8,})\b/gi, '#')
  .replace(/\d+/g, '#').slice(0, 120);
// 集約の検索と作成を同じロックで守り、同時追加も取りこぼさない。
function create(home, options, lockWaitMs) {
  return locked(home, 'info-aggregation', () => {
    const text = clean(options.text);
    if (options.kind === 'deadline') {
      if (!options.key || !/^[A-Za-z0-9_-]+$/.test(options.key)) throw new Error('deadline には有効な --key が必要です');
      const existing = listItems(home, { status: 'open' }).find(i => i.kind === 'deadline' && i.key === options.key);
      if (existing) return update(home, existing.id, current => {
        current.text = text; current.due = options.due || ''; current.remainingDays = options.remainingDays ?? null;
        current.lastAt = new Date().toISOString();
      });
    }
    // Durable producers retry after a crash between inbox delivery and ledger update.
    // Keep distinct jobs separate even when their text normalizes to the same prefix.
    if (options.dedupeKey) {
      const key = inboxDedupeKey(options.dedupeKey);
      const existing = listInboxMatches(home, item => item.dedupeKey === key && !item.autoExpired)[0];
      if (existing && options.progressAt && options.kind === 'info') {
        return update(home, existing.id, current => {
          if ((Date.parse(current.progressAt) || 0) >= Date.parse(options.progressAt)) return;
          current.text = text; current.progressAt = options.progressAt; current.lastAt = options.progressAt;
          current.repeatCount = (current.repeatCount ?? 1) + 1;
          current.status = 'open'; current.shownSessions = []; current.shownCount = 0; current.lastShownAt = null;
          current.forwardMailId = null; current.forwardError = null;
        });
      }
      if (existing && options.refresh && existing.source === 'morning-session-sweep' && options.source === existing.source && options.kind === 'info') return update(home, existing.id, current => {
        current.text = text; current.lastAt = new Date().toISOString(); current.status = 'open';
        current.shownCount = 0; current.shownSessions = []; current.lastShownAt = null;
        current.forwardMailId = options.forwardMailId || null; current.forwardError = null;
      });
      if (existing && options.refresh && (existing.source === 'auto-progress-heartbeat' || (existing.source === 'auto-progress-done' && existing.kind === 'info' && options.kind === 'ask' && ['open', 'seen'].includes(existing.status)))) return update(home, existing.id, current => {
        if (current.source === 'auto-progress-done' && (current.kind !== 'info' || !['open', 'seen'].includes(current.status))) return;
        current.text = text; current.kind = options.kind; current.status = 'open'; current.priority = 'high'; current.lastAt = new Date().toISOString();
        current.shownCount = 0; current.shownSessions = []; current.lastShownAt = null;
        current.forwardMailId = options.forwardMailId || null; current.forwardError = null;
      });
      if (existing && options.replaceExisting) return update(home, existing.id, current => {
        const changed = current.text !== text || (options.kind && current.kind !== options.kind) || (options.revision !== undefined && current.revision !== options.revision) || (options.dailyProgress && (!current.dailyProgress || current.progressDay !== options.progressDay));
        if (options.forwardMailId) current.forwardMailId = options.forwardMailId;
        if (!changed) return;
        current.text = text; current.kind = options.kind ?? current.kind; current.lastAt = new Date().toISOString(); current.status = 'open';
        if (options.incrementExisting) {
          current.count = (current.count ?? current.repeatCount ?? 1) + 1;
          current.lastSeenAt = current.lastAt;
          if (current.kind === 'info') current.repeatCount = current.count;
        }
        if (options.revision !== undefined) current.revision = options.revision;
        current.answer = null; current.answeredAt = null; current.answerSession = null;
        current.shownSessions = []; current.shownCount = 0;
        current.forwardMailId = options.forwardMailId || null; current.forwardError = null;
        if (options.dailyProgress) {
          current.dailyProgress = true; current.progressDay = options.progressDay;
          current.progressVersion = (current.progressVersion || 0) + 1;
        }
      });
      if (!existing) return createNew(home, options);
      return existing.shownSessions ? existing : readInboxItem(home, existing.id, [existing]);
    }
    const kind = options.kind ?? 'info';
    if (['ask', 'info'].includes(kind)) {
      const key = `${kind}\n${normalizeInboxText(text)}`;
      const matches = listItems(home, { status: 'open' }).filter(i => !i.dedupeKey && contentDedupeKey(i) === key).sort(newestFirst);
      for (const match of matches) {
        let merged = false;
        const item = update(home, match.id, current => {
          if (current.status !== 'open') return;
          const now = new Date().toISOString();
          current.count = (current.count ?? current.repeatCount ?? 1) + 1;
          current.lastSeenAt = now;
          if (current.kind === 'info') { current.repeatCount = current.count; current.lastAt = now; current.text = text; }
          // 進捗の再送（まとめの明示再送など）は既表示でも kim にもう一度出す。
          if (isHighInfo(current)) { current.shownSessions = []; current.shownCount = 0; }
          if (options.forwardMailId) current.forwardMailId = options.forwardMailId;
          merged = true;
        });
        if (merged) return item;
      }
    }
    return createNew(home, options);
  }, lockWaitMs);
}
export function compactItems(home) {
  return locked(home, 'info-aggregation', () => {
    const groups = new Map();
    for (const item of listItems(home, { status: 'open' })) {
      if (item.dedupeKey || item.kind !== 'info' || isHighInfo(item) || hasWorkId(item)) continue;
      const key = legacyInfoKey(item.text);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const result = { groups: 0, merged: 0 };
    for (const items of groups.values()) {
      if (items.length < 2) continue;
      const [latest, ...duplicates] = items.sort(newestFirst);
      // 回答・既読化と競合しても、閉じた項目を再び集約しない。
      update(home, latest.id, kept => {
        if (kept.status !== 'open') return;
        let merged = 0;
        for (const duplicate of duplicates) update(home, duplicate.id, current => {
          if (current.status !== 'open') return;
          kept.repeatCount = (kept.repeatCount ?? 1) + (current.repeatCount ?? 1);
          current.status = 'merged'; current.mergedInto = kept.id; merged++;
        });
        if (merged) { kept.lastAt ||= kept.createdAt; result.groups++; result.merged += merged; }
      });
    }
    return result;
  });
}
export function dedupeExisting(home, { apply = false } = {}) {
  const inspect = () => {
    const open = listItems(home, { status: 'open' }).filter(item => ['ask', 'info'].includes(item.kind));
    const groups = new Map();
    for (const item of open) {
      const key = contentDedupeKey(item);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }
    const duplicateGroups = [...groups.values()].filter(items => items.length > 1);
    const merged = duplicateGroups.reduce((total, items) => total + items.length - 1, 0);
    if (apply) for (const items of duplicateGroups) {
      const [kept, ...duplicates] = items;
      const totalCount = items.reduce((total, item) => total + (item.count ?? item.repeatCount ?? 1), 0);
      const lastSeenAt = items.map(item => item.lastSeenAt || item.lastAt || item.createdAt).sort().at(-1);
      update(home, kept.id, current => {
        if (current.status !== 'open') return;
        current.count = totalCount;
        current.lastSeenAt = lastSeenAt;
        if (current.kind === 'info') { current.repeatCount = totalCount; current.lastAt = lastSeenAt; }
      });
      for (const duplicate of duplicates) update(home, duplicate.id, current => {
        if (current.status !== 'open') return;
        current.status = 'merged'; current.mergedInto = kept.id;
      });
    }
    return { before: open.length, after: open.length - merged, groups: duplicateGroups.length, merged, applied: apply };
  };
  return apply ? locked(home, 'info-aggregation', inspect) : inspect();
}

function backupStamp(now = new Date()) {
  const part = value => String(value).padStart(2, '0');
  return `${now.getFullYear()}${part(now.getMonth() + 1)}${part(now.getDate())}-${part(now.getHours())}${part(now.getMinutes())}${part(now.getSeconds())}`;
}
export function sweepNonQuestions(home, { apply = false, now = new Date() } = {}) {
  const inspect = () => {
    const matches = listItems(home, { status: 'open' }).filter(item => item.kind === 'ask' && isNonQuestionAsk(item.text));
    const patterns = { 'check-achieved': 0, 'session-status': 0, 'gate-diagnostic': 0 };
    for (const item of matches) patterns[nonQuestionPattern(item.text)]++;
    let backup = null;
    if (apply && matches.length) {
      backup = path.join(home, '.claude', `kim-inbox.bak.${backupStamp(now)}`);
      // cpSync throws before any ledger mutation; never continue without a complete backup.
      fs.cpSync(directory(home), backup, { recursive: true, errorOnExist: true, force: false });
      for (const match of matches) update(home, match.id, current => {
        if (current.status === 'open' && current.kind === 'ask' && isNonQuestionAsk(current.text)) current.status = 'seen';
      });
    }
    return { count: matches.length, patterns, preview: matches.slice(0, 20).map(item => ({ id: item.id, text: String(item.text || '').replace(/[\r\n]+/g, ' ').slice(0, 60) })), applied: apply, backup };
  };
  return apply ? locked(home, 'info-aggregation', inspect) : inspect();
}

const rescueBranches = items => [...new Set(items.flatMap(item => String(item.text || '').match(/rescue\/(?:auto-session|sync-orgiast-main)-\d{8}-\d{6}(?:-\d+)?/g) || []))];
export function mergeItemsInto(home, dedupeKey, ids) {
  if (!dedupeKey) throw new Error('--merge-into にはキーが必要です');
  const requested = [...new Set(ids.map(id => String(id).trim()).filter(Boolean))];
  if (requested.length < 2 || requested.some(id => !validId(id))) throw new Error('--ids には有効な ID を2件以上指定してください');
  return withInboxGroupLock(home, () => {
    const byId = new Map(listItems(home).map(item => [item.id, item]));
    const items = requested.map(id => byId.get(id));
    if (items.some(item => !item)) throw new Error('指定された受信箱IDが見つかりません');
    const kept = [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0];
    const branches = rescueBranches(items);
    const total = items.reduce((sum, item) => sum + (item.count ?? item.repeatCount ?? 1), 0);
    const lastSeenAt = items.map(item => item.lastSeenAt || item.lastAt || item.createdAt).sort().at(-1);
    const latest = branches.slice().sort().at(-1) || '不明';
    const text = `rescue ブランチのレビュー・削除承認待ち（最新: ${latest} ／ 計 ${total} 件）\n対象ブランチ:\n${branches.map(branch => `- ${branch}`).join('\n')}`;
    update(home, kept.id, current => {
      current.status = 'open';
      current.kind = 'ask';
      current.dedupeKey = inboxDedupeKey(dedupeKey);
      current.text = clean(text);
      current.count = total;
      current.lastSeenAt = lastSeenAt;
      current.lastAt = lastSeenAt;
    });
    for (const item of items) {
      if (item.id === kept.id) continue;
      update(home, item.id, current => {
        current.status = 'superseded';
        current.answer = `集約先: ${kept.id}`;
        current.answeredAt = new Date().toISOString();
      });
    }
    return { keptId: kept.id, superseded: items.length - 1, count: total, branches };
  });
}
function createNew(home, { kind = 'info', text, source = '', from = resolveFleetLabel(home, { hostname: os.hostname() }), forwardMailId = null, dedupeKey, key, due, remainingDays, urgent = false, sessionId = '', priority, revision, dailyProgress = false, progressDay = '', doneWhen, progressAt, kindPromotedFrom, standingPermission, mergeHandoffReason }) {
  if (!['ask', 'info', 'deadline'].includes(kind)) throw new Error('kind は ask / info / deadline');
  if (doneWhen && kind !== 'ask') throw new Error('--done-when-gmail は ask 専用です');
  fs.mkdirSync(directory(home), { recursive: true });
  const createdAt = new Date().toISOString();
  for (;;) {
    const id = `ki-${createdAt.replace(/\D/g, '').slice(0, 14)}-${randomBytes(2).toString('hex')}`;
    const item = { id, createdAt, ...(progressAt ? { progressAt } : {}), ...(priority === 'high' ? { priority } : {}), ...(dailyProgress ? { dailyProgress: true, progressDay, progressVersion: 1, dailyShown: {} } : {}), ...(urgent ? { urgent: true } : {}), ...(sessionId ? { sessionId: clean(sessionId) } : {}), ...(kind === 'deadline' ? { key, due: due || '', remainingDays: remainingDays ?? null } : {}), ...(dedupeKey ? { dedupeKey: inboxDedupeKey(dedupeKey) } : {}), ...(['ask', 'info'].includes(kind) ? { count: 1, lastSeenAt: progressAt || createdAt } : {}), ...(kind === 'info' ? { repeatCount: 1, lastAt: progressAt || createdAt } : {}), ...(doneWhen ? { doneWhen } : {}), ...(kindPromotedFrom ? { kindPromotedFrom } : {}), ...(standingPermission ? { standingPermission } : {}), ...(mergeHandoffReason ? { mergeHandoffReason: clean(mergeHandoffReason) } : {}), kind, source: clean(source), from: clean(from), text: clean(text), status: 'open', shownSessions: [], shownCount: 0, lastShownAt: null, answeredAt: null, answer: null, answerSession: null, forwardMailId, forwardError: null };
    if (revision !== undefined) item.revision = revision;
    try { fs.writeFileSync(path.join(directory(home), `${id}.json`), JSON.stringify(item, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); return item; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
}
export function isInboxNoise({ kind = 'info', source = '', text = '' }) {
  return kind === 'info' && (source === 'gate-report' || /^gate-report\b/.test(text) || /別のパソコン[^\n]*送った連絡が(?:届いて|読まれて)/.test(text));
}
export function seenMatching(home, expression, kind = 'info') {
  if (kind !== 'info') throw new Error('--seen-matching は info 専用です');
  const pattern = new RegExp(expression);
  return listItems(home, { status: 'open' }).filter(i => i.kind === kind && (pattern.test(i.text) || pattern.test(i.source)))
    .map(i => markSeen(home, i.id));
}
// Publish complete, redacted records atomically; never depend on the aggregation lock.
export function spoolItem(home, options) {
  const dir = path.join(directory(home), 'spool');
  fs.mkdirSync(dir, { recursive: true });
  const id = randomBytes(16).toString('hex');
  const file = path.join(dir, `${id}.json`), temp = `${file}.tmp`;
  const record = { ...(options.priority === 'high' ? { priority: 'high' } : {}), kind: options.kind || 'info', text: clean(options.text), source: clean(options.source),
    ...(options.forceKind ? { forceKind: true } : {}),
    from: clean(options.from ?? resolveFleetLabel(home, { hostname: os.hostname() })),
    ...(options.progressAt ? { progressAt: options.progressAt } : {}), ...(options.sessionId ? { sessionId: clean(options.sessionId) } : {}),
    dedupeKey: options.dedupeKey ? inboxDedupeKey(options.dedupeKey) : `spool:${id}` };
  try {
    fs.writeFileSync(temp, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
  return { delivered: 'spooled', id };
}
export async function drainSpool(home, { stderr = console.error, execImpl, signal, lockWaitMs } = {}) {
  const dir = path.join(directory(home), 'spool');
  if (!fs.existsSync(dir)) return [];
  let release;
  try { release = acquireInboxLock(home, 'spool-drain', 0); }
  catch { return []; } // Another consumer will finish; records remain durable.
  const imported = [];
  try {
    // Bound each pass so a backlog cannot monopolize a hook or watchdog run.
    for (const name of fs.readdirSync(dir).filter(n => /^[a-f0-9]{32}\.json$/.test(n)).sort().slice(0, 20)) {
      const file = path.join(dir, name);
      try {
        const record = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!['ask', 'info'].includes(record.kind) || typeof record.text !== 'string' || !record.dedupeKey) throw new Error('invalid spool record');
        const item = await addItem(home, { ...record, execImpl, signal }, { drain: false, lockWaitMs });
        if (item.status === 'open' && item.forwardError) break; // Retry forwarding on the next pass as well.
        fs.unlinkSync(file);
        imported.push(item);
      } catch (error) {
        stderr(`kim-inbox: spool を保持して次回再試行: ${clean(error.message)}`);
        break;
      }
    }
  } finally { release(); }
  return imported;
}
export async function addItem(home, options, { drain = true, localOnly = false, lockWaitMs } = {}) {
  let normalizedOptions = options;
  if ((options.kind || 'info') === 'ask' && !options.forceKind && /送信|送って|承認/.test(String(options.text || ''))) {
    try {
      const config = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../config/standing-send-permissions.json', import.meta.url)), 'utf8'));
      const permission = (config.permissions || []).find(item => new RegExp(item.match).test(String(options.text || '')));
      if (permission) {
        normalizedOptions = { ...options, kind: 'info', standingPermission: permission.id };
        (options.stderr || console.error)(`常設許可あり: ${permission.name}。承認待ちにせず送信すること`);
        if (options.sessionId) {
          const ledger = path.join(home, '.claude', 'stall-ledger', 'standing-sends.jsonl');
          fs.mkdirSync(path.dirname(ledger), { recursive: true });
          fs.appendFileSync(ledger, `${JSON.stringify({ at: new Date().toISOString(), sessionId: options.sessionId, permissionId: permission.id })}\n`, { mode: 0o600 });
        }
      }
    } catch { /* 設定欠損・破損時は従来どおり */ }
  }
  if ((normalizedOptions.kind || 'info') === 'info' && !normalizedOptions.forceKind && !normalizedOptions.standingPermission && looksLikeApprovalRequest(normalizedOptions.text)) {
    normalizedOptions = { ...normalizedOptions, kind: 'ask', kindPromotedFrom: 'info' };
    (options.stderr || console.error)('[kim-inbox] kind=info で登録されましたが本文が承認を求めているため ask に昇格しました');
  }
  if ((normalizedOptions.kind || 'info') === 'ask' && isPullRequestMergeApprovalRequest(normalizedOptions.text)) {
    const reason = String(normalizedOptions.mergeHandoffReason || '').trim();
    if (!reason) {
      const error = new Error(MERGE_HANDOFF_REJECTION_MESSAGE);
      error.exitCode = 2;
      throw error;
    }
    normalizedOptions = { ...normalizedOptions, mergeHandoffReason: reason };
  }
  if (drain) await drainSpool(home, { execImpl: normalizedOptions.execImpl, signal: normalizedOptions.signal, lockWaitMs });
  if (isInboxNoise(normalizedOptions)) return { id: null, status: 'suppressed', kind: normalizedOptions.kind || 'info' };
  if (normalizedOptions.text) {
    normalizedOptions = { ...normalizedOptions, text: await resolvePrRefs(normalizedOptions.text, { execImpl: normalizedOptions.execImpl, stderr: normalizedOptions.stderr || console.error }) };
  }
  const item = create(home, normalizedOptions, lockWaitMs);
  if (localOnly || item.kind === 'deadline' || isKimSeat(home) || item.forwardMailId || ['seen', 'answered', 'dropped'].includes(item.status)) return item;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-inbox-'));
  try {
    const file = path.join(temp, 'body.txt');
    fs.writeFileSync(file, item.text, { mode: 0o600 });
    const { stdout } = await (normalizedOptions.execImpl ?? exec)(process.execPath, [fileURLToPath(new URL('./fleet-mail.mjs', import.meta.url)), '--send', '--to', 'kim-PC', '--kind', 'note', '--why', `[kim-inbox:${item.kind}] ${/^(?:auto-progress-(?:done|heartbeat)|morning-session-sweep)$/.test(item.source) ? `[source:${item.source}] ${item.dedupeKey ? `[key:${item.dedupeKey}] ` : ''}` : ''}${item.source === 'morning-session-sweep' ? '[報告・返信不要] ' : ''}${item.text.split(/\r?\n/)[0].slice(0, 60)}`, '--body-file', file], { encoding: 'utf8', windowsHide: true, timeout: 60000, signal: normalizedOptions.signal, env: { ...process.env, ORGIAST_HOME: home } });
    const id = stdout.trim().match(/^(?:送信済み: )?(mail-[A-Za-z0-9-]+)$/m)?.[1];
    if (!id) throw new Error('転送先のメールIDを取得できません');
    return update(home, item.id, current => { current.status = 'forwarded'; current.forwardMailId = id; current.forwardError = null; });
  } catch (error) {
    return update(home, item.id, current => { current.forwardError = clean(error.message); });
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
const byCreation = (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

function readArchiveIndex(home) {
  try {
    return fs.readFileSync(archiveIndex(home), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const archiveMonth = item => new Date(item.createdAt).toISOString().slice(0, 7);

function archivedItemPath(home, id, index = readArchiveIndex(home)) {
  const entry = index.find(item => item.id === id);
  return entry && path.join(archiveDirectory(home), archiveMonth(entry), `${id}.json`);
}

export function readInboxItem(home, id, index) {
  if (!validId(id)) return undefined;
  const file = path.join(directory(home), `${id}.json`);
  const read = target => {
    if (!target) return undefined;
    try { return JSON.parse(fs.readFileSync(target, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  };
  return read(file) ?? read(archivedItemPath(home, id, index)) ?? read(file);
}

// Index rows contain the fields used by history-based matching, while the
// original remains available for explicit reads and updates.
export function listInboxMatches(home, matches, { originals = false } = {}) {
  const live = listItems(home);
  const liveIds = new Set(live.map(item => item.id));
  const archived = readArchiveIndex(home).filter(item => !liveIds.has(item.id) && matches(item));
  const history = originals ? archived.map(item => readInboxItem(home, item.id, [item])).filter(Boolean) : archived;
  return live.filter(matches).concat(history).sort(byCreation);
}

function archiveEntry(item) {
  const { id, createdAt, kind, status, dedupeKey, source, forwardMailId, forwardError,
    answeredAt, lastAt, answer, text, sessionId, dailyProgress, autoExpired } = item;
  return { id, createdAt, kind, status, dedupeKey, source, forwardMailId, forwardError, answeredAt, lastAt,
    contentKey: kind === 'ask' ? contentDedupeKey(item) : undefined,
    ...(kind === 'ask' ? { answer, text, sessionId } : {}),
    ...(autoExpired ? { autoExpired } : {}),
    ...(source?.startsWith('auto-progress-human:') ? { hasText: Boolean(text) } : {}),
    ...(dailyProgress ? { dailyProgress } : {}) };
}

function writeArchiveFile(file, text) {
  const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}

function moveLockDebris(home, now) {
  const dir = directory(home), archive = archiveDirectory(home);
  let moved = 0;
  const files = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile()
    && (/\.stale-.+$/.test(entry.name) || entry.name.endsWith('.tmp'))).map(entry => path.join(dir, entry.name));
  for (const entry of fs.readdirSync(archive, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.tmp')) files.push(path.join(archive, entry.name));
  }
  for (const file of files) {
    const name = path.basename(file);
    const id = /^(ki-\d{14}-[a-f0-9]{4})\.json\./.exec(name)?.[1];
    const move = () => {
      try {
        // Item temps are protected by the item lock. Generic temps may have an active writer.
        if (!id && path.dirname(file) === dir && name.endsWith('.tmp')
          && now - fs.statSync(file).mtimeMs < STALE_LOCK_MS) return;
        const targetDir = path.join(archive, 'lock-debris');
        fs.mkdirSync(targetDir, { recursive: true });
        fs.renameSync(file, path.join(targetDir, `${randomBytes(8).toString('hex')}-${name}`));
        moved++;
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
    if (!id) move();
    else {
      const release = tryArchiveItemLock(home, id);
      if (release) try { move(); } finally { release(); }
    }
  }
  return moved;
}

function tryArchiveItemLock(home, id) {
  try { return acquireInboxLock(home, id, 0); }
  catch (error) {
    if (error.message !== 'kim-inbox: 台帳が使用中です') throw error;
    return undefined;
  }
}

export function archiveClosed(home, { apply = false, olderThanDays = 3, now = Date.now(), daily = false } = {}) {
  if (!Number.isSafeInteger(olderThanDays) || olderThanDays < 0) throw new Error('--older-than-days には 0 以上の整数を指定してください');
  const dir = directory(home), archive = archiveDirectory(home);
  const day = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  const stamp = path.join(archive, 'last-daily-run');
  const result = { applied: apply, eligible: 0, moved: 0, debrisMoved: 0 };
  const ranToday = () => daily && fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8').trim() === day;
  if (ranToday()) return result;
  const run = () => {
    if (ranToday()) return result;
    const cutoff = now - olderThanDays * DAY_MS;
    const candidates = listItems(home).filter(item => {
      if (!item.status || item.status === 'open') return false;
      const file = path.join(dir, `${item.id}.json`);
      const mtime = fs.statSync(file, { throwIfNoEntry: false })?.mtimeMs;
      if (mtime === undefined) return false;
      // For closed items, use the closed-at time when available so that
      // later updates to lastAt/mtime do not prevent archiving.
      const closedMs = item.answeredAt ? Date.parse(item.answeredAt) : NaN;
      const refTime = Number.isFinite(closedMs) ? closedMs : Math.max(mtime, ...[item.createdAt, item.answeredAt, item.lastAt]
        .map(Date.parse).filter(Number.isFinite));
      return refTime <= cutoff;
    });
    result.eligible = candidates.length;
    if (!apply) return result;
    fs.mkdirSync(archive, { recursive: true, mode: 0o700 });
    if (candidates.length) {
      const index = new Map(readArchiveIndex(home).map(entry => [entry.id, entry]));
      for (const item of candidates) index.set(item.id, archiveEntry(item));
      // Commit the index first. An interrupted move leaves the live item authoritative.
      writeArchiveFile(archiveIndex(home), [...index.values()].map(entry => JSON.stringify(entry) + '\n').join(''));
      for (const item of candidates) {
        const release = tryArchiveItemLock(home, item.id);
        if (!release) continue;
        try {
          const file = path.join(dir, `${item.id}.json`);
          // An answer, relay update or reopen may have happened since the scan.
          if (JSON.stringify(readInboxItem(home, item.id)) !== JSON.stringify(item)) continue;
          // For closed items, use answeredAt when available so that later mtime
          // updates (e.g. re-delivery touching lastAt) do not prevent archiving.
          const moveRef = item.answeredAt ? Date.parse(item.answeredAt) : NaN;
          if (Number.isFinite(moveRef) ? moveRef > cutoff : fs.statSync(file).mtimeMs > cutoff) continue;
          const month = path.join(archive, archiveMonth(item));
          fs.mkdirSync(month, { recursive: true });
          fs.renameSync(file, path.join(month, path.basename(file)));
          result.moved++;
        } finally { release(); }
      }
    }
    result.debrisMoved = moveLockDebris(home, now);
    if (daily) writeArchiveFile(stamp, day + '\n');
    return result;
  };
  return apply ? withInboxGroupLock(home, run) : run();
}

export function listItems(home, { status } = {}) {
  let files;
  try { files = fs.readdirSync(directory(home)); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return files.filter(f => validId(f.replace(/\.json$/, '')) && f.endsWith('.json')).flatMap(f => {
    try {
      const item = JSON.parse(fs.readFileSync(path.join(directory(home), f), 'utf8'));
      const valid = validId(item.id) && ['ask', 'info', 'deadline'].includes(item.kind) && typeof item.createdAt === 'string'
        && Number.isFinite(Date.parse(item.createdAt)) && typeof item.text === 'string'
        && Array.isArray(item.shownSessions) && Number.isFinite(item.shownCount);
      return valid && (!status || item.status === status) ? [item] : [];
    }
    catch { return []; } // 破損した1件で他の未回収項目を隠さない。
  }).sort(byCreation);
}
// Share the creation lock so a duplicate cannot be added during a group update.
export function withInboxGroupLock(home, fn) {
  const rawWaitMs = process.env.ORGIAST_INBOX_GROUP_LOCK_WAIT_MS;
  const waitMs = rawWaitMs?.trim() ? Number(rawWaitMs) : undefined;
  return locked(home, 'info-aggregation', fn, Number.isFinite(waitMs) && waitMs >= 0 ? waitMs : undefined);
}

export function supersedeAsk(home, id, target) {
  let changed = false;
  update(home, id, current => {
    if (current.kind !== 'ask' || current.status !== 'open') return;
    Object.assign(current, {
      status: 'superseded', supersededInto: target.id,
      answer: target.answer ?? null, answeredAt: target.answeredAt ?? null,
    });
    changed = true;
  });
  return changed;
}

function resolveItem(home, id, fields) {
  const item = update(home, id, current => Object.assign(current, fields, { answeredAt: new Date().toISOString() }));
  syncLedger(home, item);
  if (item.kind !== 'ask') return item;

  const parsed = parseEscalation(item);
  if (!parsed && !item.dedupeKey) return item;
  try {
    withInboxGroupLock(home, () => {
      const row = parsed && (readLedger(ledgerFile(home)).find(candidate => matchesRow(item, candidate))
        || { ts: parsed.ts, sessionId: item.sessionId?.slice(0, 8) === parsed.session ? item.sessionId : parsed.session });
      for (const candidate of listItems(home, { status: 'open' })) {
        if (candidate.kind !== 'ask') continue;
        if ((item.dedupeKey && candidate.dedupeKey === item.dedupeKey) || (row && matchesRow(candidate, row))) {
          supersedeAsk(home, candidate.id, item);
        }
      }
    });
  } catch (error) {
    console.error('kim-inbox: 同じ質問の整理に失敗（回答は記録済み、次回 dedupe-backfill で整理）: ' + clean(error?.message ?? error));
  }
  return item;
}

export function answerItem(home, id, answer, sessionId = '') {
  return resolveItem(home, id, { status: 'answered', answer: clean(answer), answerSession: clean(sessionId) });
}
// 質問を出す前の照合（2026-11-19）: 語をすべて含む回答済み・取り下げ済みの ask を新しい順に返す。
// 別セッションが同じ質問を kim に出し直さないよう、質問前に `--lookup "<語> <語>"` で確かめる。
export function lookupAnswers(home, query, { now = Date.now(), days = 60 } = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) throw new Error('--lookup には検索語が必要です');
  return listInboxMatches(home, item => item.kind === 'ask' && !item.autoExpired && ['answered', 'dropped'].includes(item.status)
    && now - (Date.parse(item.answeredAt || item.lastAt || item.createdAt) || 0) < days * 86400000
    && words.every(word => `${item.text}\n${item.answer || ''}`.toLowerCase().includes(word)))
    .sort((a, b) => String(b.answeredAt || b.createdAt).localeCompare(String(a.answeredAt || a.createdAt)))
    .slice(0, 20).map(item => ({ id: item.id, status: item.status, answeredAt: item.answeredAt || null, answer: item.answer, question: item.text.slice(0, 300) }));
}
// 判断待ちエスカレーションへの回答・取り下げは自動進行台帳の行にも書き戻す（翌日の再質問を止める）。
function syncLedger(home, item) {
  try { syncEscalationAnswer(home, item); } catch (error) { console.error(`kim-inbox: 台帳への回答書き戻しに失敗: ${clean(error?.message || String(error))}`); }
}
export function markSeen(home, id) {
  return update(home, id, item => { if (item.kind !== 'info') throw new Error('ask は --answer で返答を記録してください'); item.status = 'seen'; });
}
export function closeKey(home, key) {
  return locked(home, 'info-aggregation', () => listItems(home, { status: 'open' })
    .filter(i => i.kind === 'deadline' && i.key === key)
    .map(i => update(home, i.id, current => { current.status = 'seen'; })));
}
// gmail-search.mjs を子プロセスとして実行する既定の検索実装。
async function defaultGmailSearch(user, query) {
  const { execFileSync } = await import('node:child_process');
  const result = execFileSync(process.execPath, [
    fileURLToPath(new URL('./gmail-search.mjs', import.meta.url)),
    '--user', user,
    '--query', query,
    '--max', '5',
    '--json',
  ], { timeout: 20000, windowsHide: true, encoding: 'utf8' });
  return JSON.parse(result);
}
// 完了条件に Gmail の受信を指定された ask を自動的にクローズする。
// 注入可能な search(user, query) は { messages: [{ id, internalDate, subject }] } を返す。
export async function autoCloseByGmail(home, { search = defaultGmailSearch, now = Date.now() } = {}) {
  const items = listItems(home, { status: 'open' }).filter(i => i.kind === 'ask' && i.doneWhen?.gmail).slice(0, 5);
  const result = [];
  for (const item of items) {
    // スロットル: 10分未満はスキップ
    if (item.doneWhen.lastCheckedAt && now - Date.parse(item.doneWhen.lastCheckedAt) < 600_000) continue;
    try {
      const createdAt = new Date(Date.parse(item.createdAt));
      const dateStr = `${createdAt.getFullYear()}/${String(createdAt.getMonth() + 1).padStart(2, '0')}/${String(createdAt.getDate()).padStart(2, '0')}`;
      const res = await search(item.doneWhen.gmail.user, `${item.doneWhen.gmail.query} after:${dateStr}`);
      const matching = (res?.messages || []).filter(m => Number(m.internalDate) >= Date.parse(item.createdAt));
      if (matching.length > 0) {
        const latest = matching.reduce((a, b) => Number(a.internalDate) > Number(b.internalDate) ? a : b);
        const subject = (latest.subject || '').slice(0, 200);
        const date = new Date(Number(latest.internalDate)).toISOString();
        answerItem(home, item.id, `自動クローズ: ${item.doneWhen.gmail.user} に「${subject}」(${date}) 着、gmail:${latest.id}`, 'auto-gmail');
        result.push({ id: item.id, closed: true });
      } else {
        // 未マッチでも確認時刻を記録
        update(home, item.id, current => { current.doneWhen = { ...current.doneWhen, lastCheckedAt: new Date(now).toISOString() }; });
      }
    } catch (error) {
      try { update(home, item.id, current => { current.doneWhen = { ...current.doneWhen, lastCheckedAt: new Date(now).toISOString(), lastError: clean(error.message) }; }); } catch {}
    }
  }
  return result;
}
export function deadlineSheetUrl(home) {
  const config = readJsonFile(path.join(home, '.claude/deadline-watch/config.json'));
  return config?.sheetId ? `https://docs.google.com/spreadsheets/d/${config.sheetId}/edit` : '（未初期化）';
}
export function dropItem(home, id, reason, { autoExpired = false, now = Date.now() } = {}) {
  if (!String(reason ?? '').trim()) throw new Error('取り下げ理由が必要です');
  if (autoExpired) {
    let dropped = false;
    const item = update(home, id, current => {
      if (current.kind !== 'ask' || current.source !== 'auto-progress-escalate' || current.status !== 'open') return;
      Object.assign(current, { status: 'dropped', answer: clean(reason), answeredAt: new Date(now).toISOString(), autoExpired: true });
      dropped = true;
    });
    return dropped ? item : null;
  }
  return resolveItem(home, id, { status: 'dropped', answer: clean(reason) });
}
// 自動 seen の候補を選ぶ純粋関数（副作用なし）。
// 条件（AND; 全条件を満たすものが対象）:
//   1. kind === 'info'（ask は絶対に対象外）
//   2. deliveredToKim が立っている、または createdAt から 30 日以上経過
// 除外（OR; 1つでも該当で対象外）:
//   - 未配信かつ 30 日未満
//   - 本文に承認・判断を求める語（承認/判断/どちら/YES/決めて）が含まれる
// 重複: 同一 dedupeKey のグループは最新1件を残し残りを対象
export function sweepInfoCandidates(items, { now = Date.now() } = {}) {
  const openInfos = items.filter(i => i.kind === 'info' && i.status === 'open');
  const targetIds = new Set();
  const excludedReasons = [];
  const dedupeGroups = new Map(); // dedupeKey -> [{item, index}]
  for (const item of openInfos) {
    // Exclude: 承認キーワードを含むもの
    if (looksLikeApprovalRequest(item.text)) {
      excludedReasons.push({ id: item.id, reason: '承認キーワードを含む' });
      continue;
    }
    // Exclude: 未配信かつ 30 日未満
    const days = (now - Date.parse(item.createdAt)) / 86_400_000;
    if (!item.deliveredToKim && days < 30) {
      excludedReasons.push({ id: item.id, reason: '未配信かつ30日未満' });
      continue;
    }
    // 対象候補
    targetIds.add(item.id);
    // dedupeKey でグループ化
    if (item.dedupeKey) {
      if (!dedupeGroups.has(item.dedupeKey)) dedupeGroups.set(item.dedupeKey, []);
      dedupeGroups.get(item.dedupeKey).push(item);
    }
  }
  // dedupeKey 重複: 最新1件だけ残し、残りを対象に追加
  for (const [, group] of dedupeGroups) {
    if (group.length < 2) continue;
    group.sort((a, b) => (b.lastAt || b.createdAt).localeCompare(a.lastAt || a.createdAt));
    const keep = group[0];
    targetIds.delete(keep.id); // 最新1件は対象外
    for (const dup of group.slice(1)) {
      targetIds.add(dup.id); // 重複行は対象
    }
  }
  return { targetIds, excludedReasons };
}
/** 掃除サマリーを純粋関数として計算する。
 * @param {Array} allItems - 全 open 項目（listItems の返値）
 * @param {Set<string>} targetIds - seen にする対象 ID
 * @param {Array<{id:string,reason:string}>} excludedReasons - 除外理由リスト
 * @returns {{ total: number, toSeen: number, remaining: number }}
 *   total: open info の総数
 *   toSeen: seen にする件数（= targetIds.size）
 *   remaining: sweep 後も open のまま残る件数（= total - toSeen）
 */
export function computeSweepInfoSummary(allItems, targetIds, excludedReasons) {
  const total = allItems.filter(i => i.kind === 'info' && i.status === 'open').length;
  const toSeen = targetIds.size;
  const remaining = total - toSeen;
  return { total, toSeen, remaining };
}
const inboxDir = home => path.join(home, '.claude/fleet-inbox');
const readJsonFile = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
// fleet-mail.mjs と同じロック（<file>.lock を wx で取得）で受信ファイルを完了にし、サーバー同期は
// fleet-mail の pendingServer キューに委ねる。fleet-mail.mjs を import すると
// notify-kim -> kim-inbox -> fleet-mail -> … -> notify-kim の動的循環（exit 13）になるため直接書く。
function ackInboxFile(file) {
  const lock = `${file}.lock`;
  let fd;
  for (let n = 0; n < 20 && fd === undefined; n++) {
    try { fd = fs.openSync(lock, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST' && !['EPERM', 'EBUSY'].includes(error.code)) throw error;
      if (error.code === 'EEXIST' && tryReclaimLock(lock)) continue;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }
  if (fd === undefined) throw new Error('受信ファイルが使用中です');
  try {
    const current = readJsonFile(file);
    if (!current || current.status === 'done') return false;
    const at = new Date().toISOString();
    const next = { ...current, status: 'done', ackAt: at, readAt: current.readAt || at, pendingServer: [...new Set([...(current.pendingServer || []), 'ack'])] };
    const temp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
    try { fs.writeFileSync(temp, JSON.stringify(next, null, 2) + '\n'); fs.renameSync(temp, file); }
    finally { fs.rmSync(temp, { force: true }); }
    return true;
  } finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
export async function ingestFleetMail(home) {
  if (!isKimSeat(home)) return [];
  let files;
  try { files = fs.readdirSync(inboxDir(home)).filter(f => /^mail-[A-Za-z0-9-]+\.json$/.test(f)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const imported = [];
  const skipped = path.join(directory(home), '.skipped');
  for (const name of files) {
    const id = name.slice(0, -5);
    // 対象外と判定済みのメールは毎プロンプト読み直さない（古い受信箱は数千件になる）。
    if (fs.existsSync(path.join(skipped, id))) continue;
    const file = path.join(inboxDir(home), name);
    const mail = readJsonFile(file);
    if (!mail) continue;
    const kind = /^\[kim-inbox:(ask|info)\]/.exec(mail.why ?? '')?.[1];
    if (!kind) {
      fs.mkdirSync(skipped, { recursive: true });
      try { fs.writeFileSync(path.join(skipped, id), '', { flag: 'wx', mode: 0o600 }); } catch { /* 既に記録済み */ }
      continue;
    }
    const source = /\[source:(auto-progress-(?:done|heartbeat)|morning-session-sweep)\]/.exec(mail.why || '')?.[1] || 'fleet-mail';
    const producerKey = source !== 'fleet-mail' ? /\[key:([^\]\r\n]{1,240})\]/.exec(mail.why || '')?.[1] : undefined;
    const marker = path.join(directory(home), '.ingested', id);
    locked(home, 'ingest', () => {
      if (fs.existsSync(marker)) return;
      // 作成直後に終了しても forwardMailId から再発見し、二重起票を防ぐ。
      const daily = /^【進捗・毎朝】/.test(mail.body || '');
      const progressId = daily && mail.body.match(/作業ID:\s*([^\r\n]+)/)?.[1];
      const item = listInboxMatches(home, i => i.forwardMailId === id)[0] ?? (isInboxNoise({ kind, text: mail.body }) ? { id: 'suppressed', status: 'suppressed' } : create(home, { kind, text: mail.body, from: mail.from, source, ...(producerKey ? { dedupeKey: `fleet:${mail.from}:${producerKey}`, refresh: true } : {}), forwardMailId: id, ...(progressId ? { dedupeKey: `auto-progress-daily:${progressId}`, replaceExisting: true, dailyProgress: true, progressDay: new Date((Date.parse(mail.createdAt || mail.ts) || Date.now()) + 9 * 3600000).toISOString().slice(0, 10) } : {}) }));
      fs.mkdirSync(path.dirname(marker), { recursive: true });
      fs.writeFileSync(marker, item.id, { flag: 'wx', mode: 0o600 });
      imported.push(item);
    });
    // 次回も試せるようマーカー確認とは独立。
    try { ackInboxFile(file); }
    catch (error) { console.error(`kim-inbox: 取込済みメールの確認を次回再試行: ${clean(error.message).replace(/[\r\n]+/g, ' ')}`); }
  }
  return imported;
}
function deadlineDays(item, now) {
  if (item.due && /^\d{4}-\d{2}-\d{2}$/.test(item.due)) return Math.floor((Date.parse(item.due) - now) / 86400000);
  if (Number.isFinite(item.remainingDays)) return item.remainingDays;
  const days = item.text.match(/あと(-?\d+)日|(-?\d+)日超過/);
  if (days) return days[1] !== undefined ? Number(days[1]) : -Number(days[2]);
  return /期限切れ/.test(item.text) ? -Infinity : Infinity;
}
export function selectContext(items, { sessionId = '', now = Date.now(), sheetUrl = '（未初期化）', home = process.env.ORGIAST_HOME || os.homedir(), event = 'UserPromptSubmit' } = {}) {
  items = items.filter(item => relayDue(item, sessionId, now));
  const own = item => {
    if (sessionId.length < 8) return false;
    const current = sessionId.slice(0, 8).toLowerCase();
    if (String(item.sessionId ?? '').slice(0, 8).toLowerCase() === current) return true;
    return [...item.text.matchAll(/(?:作業ID:|セッション)\s*([a-f0-9]{8})(?![a-f0-9])/gi)]
      .some(match => match[1].toLowerCase() === current);
  };
  const ledger = items.some(i => i.dailyProgress) ? readLedger(ledgerFile(home)) : [];
  const pending = items.filter(item => {
    if (item.status !== 'open' && !(item.dailyProgress && item.status === 'seen')) return false;
    if (!item.dailyProgress) return true;
    const rows = ledger.filter(row => row.sessionId === item.dedupeKey?.replace(/^auto-progress-daily:/, ''));
    return !rows.length || rows.some(row => OPEN_STATUSES.has(row.status));
  });
  const date = new Date(now + 9 * 3600000), day = date.toISOString().slice(0, 10);
  const daily = pending.filter(item => {
    if (!item.dailyProgress || event !== 'UserPromptSubmit') return false;
    const previous = item.dailyShown?.[sessionId];
    return !previous || previous.version !== (item.progressVersion || 1)
      || (date.getUTCHours() >= 9 && previous.day !== day);
  });
  const eligible = pending.filter(item => !item.dailyProgress || daily.includes(item));
  if (!eligible.length) return '';
  const unseenFirst = (a, b) => a.shownCount - b.shownCount || newestFirst(a, b);
  const staleUnshown = item => item.shownCount === 0 && now - Date.parse(item.createdAt) > 3 * 86400000;
  const askPriority = (a, b) => Number(staleUnshown(b)) - Number(staleUnshown(a)) || unseenFirst(a, b);
  const reserved = eligible.filter(i => !(i.kind === 'ask' && own(i))
    && (i.source === 'auto-progress-done' || i.source === 'auto-progress-heartbeat' || i.priority === 'high'));
  // Reserve progress before approvals so hundreds of asks cannot starve it.
  const required = [
    ...reserved.filter(i => i.kind === 'info').sort((a, b) =>
      Number(b.source === 'auto-progress-heartbeat') - Number(a.source === 'auto-progress-heartbeat') || unseenFirst(a, b)).slice(0, 3),
    ...reserved.filter(i => i.kind === 'ask').sort(unseenFirst).slice(0, 5),
  ];
  const allAsks = eligible.filter(i => i.kind === 'ask');
  const infos = eligible.filter(i => i.kind === 'info' && !i.dailyProgress);
  const deadlines = eligible.filter(i => i.kind === 'deadline').sort((a, b) => Number(own(b)) - Number(own(a))
    || deadlineDays(a, now) - deadlineDays(b, now) || String(a.key).localeCompare(String(b.key)));
  const sessionInfos = infos.filter(own).sort(unseenFirst);
  const highInfos = infos.filter(i => !own(i) && isHighInfo(i)).sort(unseenFirst);
  const otherInfos = infos.filter(i => !own(i) && !isHighInfo(i)).sort(newestFirst);
  const candidates = [...new Set([
    ...required,
    ...allAsks.filter(own).sort(askPriority).slice(0, 5),
    ...daily.sort(unseenFirst),
    ...allAsks.filter(i => i.urgent && !own(i)).sort(askPriority).slice(0, 5),
    ...sessionInfos, ...highInfos.slice(0, 3),
    ...deadlines.slice(0, 5),
    ...allAsks.filter(i => !i.urgent && !own(i) && !reserved.includes(i)).sort(askPriority).slice(0, 5),
    ...highInfos.slice(3, 5),
    ...otherInfos.slice(0, 2),
  ])];
  const label = eligible.every(i => reserved.includes(i)) ? '完了・進捗・承認待ち'
    : `期限 ${deadlines.length} / 未回収 ask ${allAsks.length} / 未確認 info ${infos.length}`;
  let text = `[kim-inbox ${label}] 最後の【受信箱】節に、各件を『何の件／起きたこと／判断してほしいこと／返事の例』で書く。原文を切り詰めて貼らない。注入は配達ではない。ask は返答後 --answer、info は報告後 --seen で記録する。\n`;
  if (deadlines.length) text += `期限台帳: ${sheetUrl}（返答後は deadline-watch.mjs --done/--defer/--drop）\n`;
  text = redactSecrets(text);
  const footer = '一覧: node tools/kim-inbox.mjs --list --open';
  // Budget the final rendered text before marking an item shown. Never slice a brief.
  const omitted = count => count ? `ほか ${count} 件\n` : '';
  const selected = [];
  // Group duplicate items by work ID + decide for deduplicated display
  const groups = groupInboxItems(candidates);
  const groupedCandidates = groups.map(g => g.representative);
  const duplicateMap = new Map();
  for (const group of groups) {
    if (group.duplicates.length > 0) duplicateMap.set(group.representative.id, group.duplicates);
  }
  for (const item of groupedCandidates) {
    if (otherInfos.includes(item) && [...sessionInfos, ...highInfos].some(i => !i.shownCount && !selected.includes(i))) continue;
    let brief = redactSecrets(formatInboxBrief(item, selected.length + 1, { home }));
    const extras = duplicateMap.get(item.id);
    if (extras?.length) {
      const lines = brief.split('\n');
      const dupeDisplay = extras.slice(0, 5).join(', ');
      lines[0] += `（同じ件: ${dupeDisplay}${extras.length > 5 ? '…' : ''}）`;
      brief = lines.join('\n');
    }
    brief += '\n';
    if ((text + brief + omitted(eligible.length - selected.length - 1) + footer).length > CONTEXT_LIMIT) continue;
    text += brief;
    selected.push(item);
    item.shownSessions = [...new Set([...item.shownSessions, sessionId])];
    item.shownCount++; item.lastShownAt = new Date(now).toISOString();
    // Mark duplicates as shown so they enter relay state and can be receipted
    if (extras?.length) {
      for (const dupId of extras) {
        const dup = items.find(i => i.id === dupId);
        if (dup) {
          dup.shownSessions = [...new Set([...dup.shownSessions, sessionId])];
          dup.shownCount++; dup.lastShownAt = new Date(now).toISOString();
        }
      }
    }
    if (daily.includes(item)) {
      const previous = item.dailyShown?.[sessionId];
      item.dailyShown = { ...(item.dailyShown || {}), [sessionId]: {
        day: date.getUTCHours() >= 9 ? day : previous?.day || '', version: item.progressVersion || 1,
      } };
    }
  }
  return text + omitted(eligible.length - selected.length) + footer;
}
export function oneScreenSummary(items) {
  const openItems = items.filter(i => i.status === 'open');
  const asks = openItems.filter(i => i.kind === 'ask').sort(byCreation);
  const infos = openItems.filter(i => i.kind === 'info').sort(byCreation);
  const lines = [];
  const askCount = asks.length;
  lines.push(`📌 kim の返事待ち ${askCount}件`);
  if (askCount === 0) return lines.join('\n');
  for (const ask of asks.slice(0, 5)) {
    const text = ask.text.replace(/[\r\n]+/g, ' ').slice(0, 120);
    lines.push(`${text} (${ask.id})`);
  }
  if (infos.length > 0) {
    lines.push(`📲 自動進行の結果`);
    for (const info of infos.slice(0, 5)) {
      const text = info.text.replace(/[\r\n]+/g, ' ').slice(0, 120);
      lines.push(text);
    }
  }
  const totalOpen = openItems.length;
  const shownTotal = Math.min(askCount, 5) + Math.min(infos.length, 5);
  const remaining = totalOpen - shownTotal;
  if (remaining > 0) lines.push(`ほか ${remaining}件: node tools/kim-inbox.mjs --list`);
  let summary = lines.join('\n');
  while (lines.length > 0 && Buffer.from(lines.join('\n'), 'utf8').length > 2000) lines.pop();
  return lines.length === 0 ? `📌 kim の返事待ち ${askCount}件` : lines.join('\n');
}
export async function batchFile(home, filename, { stderr = console.error, drain = drainSpool } = {}) {
  const lines = fs.readFileSync(filename, 'utf8').split(/\r?\n/).filter(line => line.trim());
  await drain(home, { stderr });
  const results = [];
  for (const line of lines) {
    let operation;
    try {
      operation = JSON.parse(line);
      const { key, op } = operation;
      if (typeof key !== 'string' || !key.trim()) throw new Error('key is required');
      if (op === 'add') {
        if (typeof operation.text !== 'string') throw new Error('text is required');
        const item = await addItem(home, { kind: operation.kind, key, due: operation.due,
          remainingDays: operation.remainingDays, source: operation.source,
          text: await enrichPullRequestUrls(operation.text), stderr }, { drain: false });
        results.push({ key, op, ok: true, id: item.id });
      } else if (op === 'close-key') {
        closeKey(home, key);
        results.push({ key, op, ok: true });
      } else throw new Error('unknown operation');
    } catch (error) {
      results.push({ key: operation?.key ?? null, op: operation?.op ?? null, ok: false, error: clean(error.message) });
    }
  }
  return results;
}
export async function main(args = process.argv.slice(2), { home = process.env.ORGIAST_HOME || os.homedir(), stdout = console.log, stderr = console.error, readStdin = readStdinWithTimeout } = {}) {
  const value = flag => args[args.indexOf(flag) + 1];
  try {
    if (args.includes('--context')) {
      // 100ms では混雑時に入力を読み切れず、何も表示せず終わっていた（2026-11-04 実測 3回中1回）。
      const input = JSON.parse(await readStdin(2000));
      const event = input.hook_event_name;
      if (!['SessionStart', 'UserPromptSubmit'].includes(event)) return 0;
      const kim = isKimSeat(home);
      if (!interactiveInboxSession(input, { home })) return 0;
      const sessionId = String(input.session_id ?? '');
      let nlHints = '';
      if (kim && event === 'UserPromptSubmit') {
        recordPromptAnswers(home, sessionId, String(input.prompt || ''), { listItems, answerItem });
        const nlResult = recordNaturalLanguageAnswers(home, sessionId, String(input.prompt || ''), { listItems, answerItem });
        if (nlResult.hints.length) nlHints = nlResult.hints.join('\n');
      }
      await drainSpool(home);
      if (kim) await ingestFleetMail(home);
      await autoCloseByGmail(home);
      // 前回示した info を自動 seen にする（ask は対象外。表示予算に入ったものだけがカウントされる）
      if (kim && sessionId) {
        const state = readRelayState(home, sessionId);
        if (state.seenAfterPending?.length) {
          for (const id of state.seenAfterPending) {
            try { markSeen(home, id); } catch { /* 既に seen または info 以外は無視 */ }
          }
          state.seenAfterPending = [];
          writeRelayState(home, sessionId, state);
        }
      }
      const active = i => (i.status === 'open' || (i.dailyProgress && i.status === 'seen')) && (kim || i.forwardError);
      const items = listInboxMatches(home, active, { originals: true });
      const counts = new Map(items.map(i => [i.id, i.shownCount]));
      const context = selectContext(items, { sessionId: String(input.session_id ?? ''), sheetUrl: deadlineSheetUrl(home), home, event });
      if (kim) recordInjection(home, sessionId, items.filter(i => i.shownCount !== counts.get(i.id) && (i.kind === 'ask' || isHighInfo(i))), { event });
      // 今回新たに示した info を次回の自動 seen に記録する
      if (kim && sessionId) {
        const newlyShownInfo = items.filter(i => i.shownCount !== counts.get(i.id) && i.kind === 'info');
        if (newlyShownInfo.length) {
          const state = readRelayState(home, sessionId);
          state.seenAfterPending = [...new Set([...(state.seenAfterPending || []), ...newlyShownInfo.map(i => i.id)])];
          writeRelayState(home, sessionId, state);
        }
      }
      const contextParts = [];
      if (context) contextParts.push(context);
      if (nlHints) contextParts.push(nlHints);
      const mergedContext = contextParts.join('\n\n');
      if (mergedContext) stdout(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: mergedContext } }));
      for (const item of items.filter(i => i.shownCount !== counts.get(i.id))) update(home, item.id, current => {
        current.shownSessions = [...new Set([...current.shownSessions, ...item.shownSessions])]; current.shownCount++; current.lastShownAt = item.lastShownAt;
        if (item.dailyShown) current.dailyShown = { ...(current.dailyShown || {}), ...item.dailyShown };
      });
    } else if (args.includes('--show')) {
      // The brief's fallback must offer a read-only path to the complete original.
      const item = readInboxItem(home, value('--show'));
      if (!item) throw new Error('指定された受信箱IDが見つかりません');
      stdout(args.includes('--json') ? JSON.stringify(item) : redactSecrets(item.text));
    } else if (args.includes('--batch-file')) {
      stdout(JSON.stringify(await batchFile(home, value('--batch-file'), { stderr })));
    } else if (args.includes('--add')) {
      const positionalKind = args[args.indexOf('--add') + 1];
      const kind = args.includes('--kind') ? value('--kind')
        : ['ask', 'info', 'deadline'].includes(positionalKind) ? positionalKind : 'info';
      const body = await enrichPullRequestUrls(fs.readFileSync(value('--body-file'), 'utf8'));
      let doneWhen;
      if (args.includes('--done-when-gmail')) {
        const raw = value('--done-when-gmail');
        const pipe = raw.indexOf('|');
        if (pipe === -1) throw new Error('--done-when-gmail は "user|query" 形式で指定してください');
        doneWhen = { gmail: { user: raw.slice(0, pipe).trim(), query: raw.slice(pipe + 1).trim() } };
      }
      const item = await addItem(home, { urgent: args.includes('--urgent'), text: body, kind, forceKind: args.includes('--force-kind'), stderr, key: args.includes('--key') ? value('--key') : undefined, dedupeKey: args.includes('--dedupe-key') ? value('--dedupe-key') : undefined, replaceExisting: args.includes('--replace-existing'), due: args.includes('--due') ? value('--due') : undefined, remainingDays: args.includes('--remaining-days') ? Number(value('--remaining-days')) : undefined, source: args.includes('--source') ? value('--source') : '', mergeHandoffReason: args.includes('--merge-handoff-ok') ? value('--merge-handoff-ok') : undefined, ...(doneWhen ? { doneWhen } : {}) });
      stdout(JSON.stringify({ id: item.id, status: item.status, forwarded: item.status === 'forwarded' }));
    } else if (args.includes('--answer')) stdout(JSON.stringify(answerItem(home, value('--answer'), fs.readFileSync(value('--body-file'), 'utf8'), process.env.CLAUDE_SESSION_ID || '')));
    else if (args.includes('--lookup')) stdout(JSON.stringify(lookupAnswers(home, value('--lookup')), null, 2));
    else if (args.includes('--seen-matching')) stdout(JSON.stringify(seenMatching(home, value('--seen-matching'), args.includes('--kind') ? value('--kind') : 'info')));
    else if (args.includes('--seen')) stdout(JSON.stringify(markSeen(home, value('--seen'))));
    else if (args.includes('--close-key')) stdout(JSON.stringify(closeKey(home, value('--close-key'))));
    else if (args.includes('--drop')) stdout(JSON.stringify(dropItem(home, value('--drop'), args.includes('--reason') ? value('--reason') : '')));
    else if (args.includes('--compact')) stdout(JSON.stringify(compactItems(home)));
    else if (args.includes('--merge-into')) stdout(JSON.stringify(mergeItemsInto(home, value('--merge-into'), value('--ids').split(','))));
    else if (args.includes('--dedupe-existing')) {
      const result = dedupeExisting(home, { apply: args.includes('--apply') });
      stdout(`kim-inbox dedupe-existing${result.applied ? ' (apply)' : ' (dry)'}: ${result.before}件 → ${result.after}件（重複 ${result.merged}件、${result.groups}グループ）`);
    }
    else if (args.includes('--sweep-nonquestions')) {
      const result = sweepNonQuestions(home, { apply: args.includes('--apply') });
      stdout(`kim-inbox sweep-nonquestions${result.applied ? ' (apply)' : ' (dry-run)'}: ${result.count}件`);
      stdout(`内訳: check-achieved=${result.patterns['check-achieved']} / session-status=${result.patterns['session-status']} / gate-diagnostic=${result.patterns['gate-diagnostic']}`);
      for (const item of result.preview) stdout(`${item.id} ${item.text}`);
      if (result.backup) stdout(`backup: ${result.backup}`);
    }
    else if (args.includes('--archive-closed')) {
      const apply = args.includes('--apply');
      if (apply && args.includes('--dry')) throw new Error('--dry と --apply は併用できません');
      const raw = args.includes('--older-than-days') ? value('--older-than-days') : '3';
      if (!/^\d+$/.test(raw ?? '')) throw new Error('--older-than-days には 0 以上の整数を指定してください');
      stdout(JSON.stringify(archiveClosed(home, { apply, olderThanDays: Number(raw) })));
    }
    else if (args.includes('--auto-close')) {
      const result = await autoCloseByGmail(home);
      archiveClosed(home, { apply: true, daily: true });
      stdout(JSON.stringify(result));
    }
    else if (args.includes('--status') || args.includes('--list')) {
      await autoCloseByGmail(home);
      const items = args.includes('--open') || args.includes('--status') ? listItems(home, { status: 'open' })
        : listInboxMatches(home, () => true, { originals: true });
      if (args.includes('--status')) stdout(`kim-inbox: open ask ${items.filter(i => i.kind === 'ask').length} / open info ${items.filter(i => i.kind === 'info').length}\n最古: ${items.length ? `${items[0].id} ${items[0].text.split(/\r?\n/)[0].slice(0, 120)}` : 'なし'}`);
      else stdout(args.includes('--json') ? JSON.stringify(items) : displayPcNames(items.map(i => `${i.id} ${i.kind} ${i.status} ${i.text.split(/\r?\n/)[0]}${(i.count ?? i.repeatCount ?? 1) >= 2 ? ` (同じ内容 ${i.count ?? i.repeatCount} 件)` : ''}`).join('\n'), { home }));
    } else if (args.includes('--sweep-info')) {
      const apply = args.includes('--apply');
      const allItems = listItems(home, { status: 'open' });
      const { targetIds, excludedReasons } = sweepInfoCandidates(allItems);
      const summary = computeSweepInfoSummary(allItems, targetIds, excludedReasons);
      // 内訳（登録元別）
      const targetItems = allItems.filter(i => targetIds.has(i.id));
      const sourceBreakdown = {};
      for (const item of targetItems) {
        const s = item.source || '(empty)';
        sourceBreakdown[s] = (sourceBreakdown[s] || 0) + 1;
      }
      const sourceTop = Object.entries(sourceBreakdown).sort((a, b) => b[1] - a[1]).slice(0, 10);
      // 除外の内訳
      const excludedByReason = {};
      for (const { reason } of excludedReasons) excludedByReason[reason] = (excludedByReason[reason] || 0) + 1;
      if (apply) {
        for (const id of targetIds) markSeen(home, id);
        stdout(`kim-inbox sweep-info: ${targetIds.size} 件を seen にしました`);
      } else {
        const lines = [
          `kim-inbox sweep-info (dry-run):`,
          `open info ${summary.total} 件 → seen にする ${summary.toSeen} 件 / open のまま残る ${summary.remaining} 件`,
          '',
          '除外の内訳:',
        ];
        for (const [reason, count] of Object.entries(excludedByReason)) lines.push(`  ${reason}: ${count}件`);
        lines.push('');
        lines.push('対象の内訳（登録元 上位10）:');
        for (const [source, count] of sourceTop) lines.push(`  ${source}: ${count}件`);
        stdout(lines.join('\n'));
      }
    } else throw new Error('--add / --answer / --seen / --drop / --show / --list / --status / --context / --compact / --merge-into <key> --ids <id,...> / --dedupe-existing [--dry|--apply] / --sweep-info [--apply] / --sweep-nonquestions [--apply] / --auto-close を指定してください');
    return 0;
  } catch (error) { stderr(`kim-inbox: ${clean(error.message).replace(/[\r\n]+/g, ' ')}`); return args.includes('--context') ? 0 : (error.exitCode || 1); }
}
export const __test = { sweepInfoCandidates, computeSweepInfoSummary, listItems, markSeen };
if (isEntry(import.meta.url)) process.exitCode = await main();
