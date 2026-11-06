import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getDriveToken } from './drive-auth.mjs';
import { gwsFetch } from './gws-proxy.mjs';
import { headerValue, extractBody } from '../gmail-search.mjs';
import { addItem } from '../kim-inbox.mjs';
import { jstDay } from './auto-progress-daily.mjs';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const mailboxes = ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
const addresses = text => [...new Set(String(text || '').toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g) || [])].sort();
const recipients = message => addresses(['To', 'Cc', 'Bcc'].map(key => headerValue(message.payload, key)).join(','));
const subject = message => clean(headerValue(message.payload, 'Subject').replace(/^\s*(?:(?:re|fw|fwd|返信|転送)\s*[:：]\s*)+/gi, '')).toLowerCase();
export const draftBody = message => clean(extractBody(message?.payload, 100000));
export const draftFingerprint = message => hash([message.id, message.internalDate, message.payload]);
export const nonHumanRecipient = address => /@mail-receiver\.freee\.co\.jp$/i.test(address) || /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster|notifications?)(?:[+@._-]|$)/i.test(address);
export const mailboxDraftLabel = mailbox => `（${String(mailbox || 'メールボックス不明').replace(/@.*$/, '@')} の下書き）`;
export function clearedReason(draft, sent, sameMailbox) {
  const sentAt = Number(sent.internalDate), draftAt = Number(draft.internalDate);
  if (!(sent.labelIds || []).includes('SENT') || !Number.isFinite(sentAt) || !Number.isFinite(draftAt) || draftAt <= 0 || sentAt <= draftAt) return null;
  if (sameMailbox && draft.threadId && draft.threadId === sent.threadId) return '不要（後で別の返信を送信済み）';
  const to = recipients(draft);
  if (!to.length || JSON.stringify(to) !== JSON.stringify(recipients(sent))) return null;
  const a = subject(draft), b = subject(sent);
  const prefix = Array.from(draftBody(draft)).slice(0, 100).join(''), other = Array.from(draftBody(sent)).slice(0, 100).join('');
  return (a && a === b) || (prefix && prefix === other) ? '送信済み' : null;
}
export async function gmailClient(mailbox, { getToken = getDriveToken, fetchImpl = gwsFetch, write = false } = {}) {
  const token = await getToken({ scope: `https://www.googleapis.com/auth/gmail.${write ? 'compose' : 'readonly'}`, impersonate: mailbox, signal: AbortSignal.timeout(20000) });
  return async (route, { method = 'GET', optional = false } = {}) => {
    const response = await fetchImpl(`${API}${route}`, { method, headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) });
    if (optional && [404, 410].includes(response.status)) return null;
    if (!response.ok) throw new Error(`Gmail ${mailbox}: HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}
export async function allPages(get, route, field) {
  const out = []; let token = '';
  const seen = new Set();
  do {
    const result = await get(`${route}${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
    out.push(...(result[field] || []));
    token = result.nextPageToken || '';
    if (token && seen.has(token)) throw new Error('Gmail のページ取得が循環しました');
    seen.add(token);
  } while (token);
  return out;
}
const file = home => path.join(home, '.claude/state/drafts-auto-cleared.jsonl');
export function clearedRecords(home) {
  try { return fs.readFileSync(file(home), 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}
function appendDurable(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const fd = fs.openSync(filename, 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify(value) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export async function filterClearedDrafts(items, { home, now, deps = {}, stats }) {
  const drafts = items.filter(item => item.kind === 'draft' && item.draftMessage);
  const clients = new Map();
  const get = async mailbox => {
    if (!clients.has(mailbox)) clients.set(mailbox, await gmailClient(mailbox, deps));
    return clients.get(mailbox);
  };
  const known = new Set(clearedRecords(home).filter(row => row.event === 'cleared').map(row => row.key));
  const excluded = new Set();
  for (const item of drafts) {
    const draft = item.draftMessage;
    const external = recipients(draft).filter(address => !/@orgiast\.jp$/.test(address));
    let reason = external.length && external.every(nonHumanRecipient) ? '人でない宛先' : null;
    try {
      if (!reason) {
      const own = await get(item.mailbox);
      if (draft.threadId) {
        const thread = await own(`/threads/${encodeURIComponent(draft.threadId)}?format=full`, { optional: true });
        if (thread?.messages?.some(sent => clearedReason(draft, sent, true) === '不要（後で別の返信を送信済み）')) reason = '不要（後で別の返信を送信済み）';
      }
      for (const mailbox of mailboxes) {
        if (reason) break;
        const client = await get(mailbox);
        const to = recipients(draft);
        if (!to.length) continue;
        const query = `in:sent {to:${to[0]} cc:${to[0]} bcc:${to[0]}} after:${Math.floor(Number(draft.internalDate) / 1000)}`;
        const stubs = await allPages(client, `/messages?q=${encodeURIComponent(query)}&maxResults=100`, 'messages');
        for (const stub of stubs) {
          const sent = await client(`/messages/${encodeURIComponent(stub.id)}?format=full`, { optional: true });
          if (sent && (reason = clearedReason(draft, sent, mailbox === item.mailbox))) break;
        }
      }
      }
    } catch (error) {
      stats.draftCheckErrors = (stats.draftCheckErrors || 0) + 1;
      item.draftCheckError = String(error.message).slice(0, 200);
      continue; // Unverified drafts remain visible, including after a prior exclusion.
    }
    if (!reason) continue;
    const fingerprint = draftFingerprint(draft), key = hash([item.mailbox, item.draftId, fingerprint]);
    if (!known.has(key)) {
      appendDurable(file(home), { event: 'cleared', key, at: new Date(now).toISOString(), mailbox: item.mailbox,
        draftId: item.draftId, fingerprint, reason, subject: item.subject });
      known.add(key);
    }
    excluded.add(item.id);
  }
  if (drafts.length) { stats.draftsChecked = drafts.length; stats.draftsCleared = excluded.size; stats.draftsKept = drafts.length - excluded.size; }
  return items.filter(item => !excluded.has(item.id)).map(({ draftMessage, ...item }) => item);
}
export async function notifyClearedDrafts(home, { now, add = addItem } = {}) {
  const records = clearedRecords(home);
  const deleted = new Set(records.filter(row => row.event === 'deleted').map(row => row.key));
  const latest = new Map();
  for (const row of records.filter(row => row.event === 'cleared')) latest.set(`${row.mailbox}:${row.draftId}`, row);
  const pending = [...latest.values()].filter(row => !deleted.has(row.key));
  if (!pending.length) return;
  const day = jstDay(now);
  const reasons = Object.entries(pending.reduce((out, row) => ({ ...out, [row.reason]: (out[row.reason] || 0) + 1 }), {})).map(([reason, count]) => `${reason}: ${count}件`).join('／');
  const send = async options => {
    const item = await add(home, options);
    if (!item?.id || item.forwardError) throw new Error(item?.forwardError || '下書き整理の通知に失敗');
  };
  if (!records.some(row => row.event === 'summary' && row.day === day)) {
    await send({ kind: 'info', source: 'drafts-auto-cleared', dedupeKey: `drafts-auto-cleared:summary:${day}`,
      text: `自動で一覧から外した下書き ${pending.length}件（${reasons}）。下書き自体は削除していません。` });
    appendDurable(file(home), { event: 'summary', day, at: new Date(now).toISOString() });
  }
  await send({ kind: 'ask', source: 'drafts-auto-cleared', dedupeKey: 'drafts-auto-cleared:approval', replaceExisting: true,
    revision: hash(pending.map(row => row.key).sort()),
    text: `一覧から外した下書き ${pending.length}件（${reasons}）をまとめて削除してよいですか。承認後、本文を退避してから削除します。\n承認後の実行: node tools/external-waiting.mjs --delete-cleared --approved-by kim` });
}
export async function deleteClearedDrafts({ home, approvedBy, now = Date.now(), deps = {} }) {
  if (approvedBy !== 'kim') throw new Error('下書きの削除には kim の承認が必要です');
  const records = clearedRecords(home), done = new Set(records.filter(row => row.event === 'deleted').map(row => row.key));
  const latest = new Map();
  for (const row of records.filter(row => row.event === 'cleared' && !done.has(row.key))) latest.set(`${row.mailbox}:${row.draftId}`, row);
  const clients = new Map(), result = { total: latest.size, deleted: 0, missing: 0, changed: 0, failed: 0 };
  for (const row of latest.values()) {
    try {
      if (!mailboxes.includes(row.mailbox)) throw new Error('対象外のメールボックス');
      if (!clients.has(row.mailbox)) clients.set(row.mailbox, await gmailClient(row.mailbox, { ...deps, write: true }));
      const get = clients.get(row.mailbox), route = `/drafts/${encodeURIComponent(row.draftId)}`;
      const draft = await get(`${route}?format=full`, { optional: true });
      if (!draft) { result.missing++; appendDurable(file(home), { event: 'deleted', key: row.key, at: new Date(now).toISOString(), reason: '既に存在しない' }); continue; }
      if (draftFingerprint(draft.message) !== row.fingerprint) { result.changed++; continue; }
      appendDurable(path.join(home, '.claude/state/drafts-deleted-backup.jsonl'), { ...row, backedUpAt: new Date(now).toISOString(), draft });
      await get(route, { method: 'DELETE' });
      appendDurable(file(home), { event: 'deleted', key: row.key, at: new Date(now).toISOString(), approvedBy });
      result.deleted++;
    } catch { result.failed++; }
  }
  return result;
}
