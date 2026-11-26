#!/usr/bin/env node
/**
 * 送信待ち台帳 v2 — 止まった件を必ず追う。
 * schema: unsent-ledger/v2
 *
 * 状態: 承認待ち / 自動送信待ち / 止まった / 送信未確認 / 送信済み / 取り下げ
 * PENDING = 承認待ち・自動送信待ち・送信未確認・止まった
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { searchGmail } from './gmail-search.mjs';
import { isEntry } from './is-entry.mjs';

const SCHEMA = 'unsent-ledger/v2';
const STATUSES = Object.freeze([
  '承認待ち',
  '自動送信待ち',
  '止まった',
  '送信未確認',
  '送信済み',
  '取り下げ',
]);
export const PENDING_STATUSES = Object.freeze([
  '承認待ち',
  '自動送信待ち',
  '送信未確認',
  '止まった',
]);
const CHANNELS = Object.freeze(['email', 'discord', 'line', 'beeper', 'kurashi', 'fax', 'other']);
const HOME = () => process.env.ORGIAST_HOME || os.homedir();
const ROOT = () => path.join(HOME(), '.claude', 'unsent-ledger');
const LEDGER = () => path.join(ROOT(), 'ledger.json');
const DEFAULT_EXPORT_DIR = () => path.join(os.homedir(), 'gb-reports', 'unsent-ledger');
const GB_INBOX = () => path.join(os.homedir(), 'gb-reports', 'unsent-ledger', 'inbox');
const GB_REPORTS = () => path.join(os.homedir(), 'gb-reports');
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const nowIso = () => new Date().toISOString();
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const atomicJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmp, file);
};
const atomicText = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
};
const jstStamp = (d = new Date()) => d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', hour12: false });
const hashId = (s) => `path-${crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16)}`;
const asArray = (v) => (Array.isArray(v) ? v : v ? [v] : []);
const isInternalAddress = (addr) => /@orgiast\.jp\s*$/i.test(String(addr || '').trim());

export function hasKimDecision(item) {
  const text = String(item?.decided_by || '');
  if (!/(金さん|金功勇|kim)/i.test(text)) return false;
  return /\d{1,2}\/\d{1,2}|\d{4}-\d{2}-\d{2}|t[0-9a-z]{3,}|セッション|session/i.test(text);
}

export function isPending(item) {
  const s = item?.status;
  if (PENDING_STATUSES.includes(s)) return true;
  // v1 互換: 照合対象だった旧ステータス
  return s === '未送信' || s === '保留';
}

function mapLegacyStatus(item) {
  const raw = String(item?.status || '');
  if (STATUSES.includes(raw)) return { status: raw, reason: item.status_reason || item.stop_reason || '' };
  if (raw === '未送信' || raw === '') return { status: '承認待ち', reason: item.status_reason || item.stop_reason || '' };
  if (raw === '保留') return { status: '止まった', reason: item.status_reason || item.stop_reason || '旧:保留' };
  if (raw === '送信済み' || /sent/i.test(raw)) return { status: '送信済み', reason: item.status_reason || '' };
  return { status: '承認待ち', reason: item.status_reason || item.stop_reason || `旧status:${raw || '(空)'}` };
}

export function setStatus(item, status, reason = '', { by = 'system' } = {}) {
  if (!STATUSES.includes(status)) throw new Error(`invalid status: ${status}`);
  if (status === '止まった' && !String(reason || '').trim()) {
    throw new Error('止まった には reason 必須');
  }
  if (status === '取り下げ' && !hasKimDecision(item)) {
    throw new Error('取り下げ は金さんの決定記録（hasKimDecision）が必要');
  }
  const at = nowIso();
  item.status = status;
  item.status_reason = reason || '';
  if (!Array.isArray(item.history)) item.history = [];
  item.history.push({ at, status, reason: reason || '', by });
  return item;
}

export function migrateItem(item) {
  const next = { ...item };
  const mapped = mapLegacyStatus(next);
  if (!STATUSES.includes(String(item.status || ''))) {
    next.status = mapped.status;
    next.status_reason = mapped.reason;
  } else {
    next.status_reason = next.status_reason || next.stop_reason || '';
  }
  if (!CHANNELS.includes(next.channel)) next.channel = 'email';
  next.to = asArray(next.to);
  next.cc = asArray(next.cc);
  next.evidence = asArray(next.evidence);
  next.history = Array.isArray(next.history) ? next.history : [];
  next.unconfirmed_checks = Number(next.unconfirmed_checks || 0);
  if (typeof next.internal !== 'boolean') {
    const addrs = [...next.to, ...(next.cc || [])];
    next.internal = addrs.length > 0 && addrs.every(isInternalAddress);
  }
  if (!next.case || /^\s*[A-Z]?\d[\w-]*\s*$/.test(String(next.case))) {
    const label = [next.client, next.case].filter(Boolean).join(' / ');
    if (label) next.case = label;
  }
  if (!next.decided_at && next.decided_date) {
    const d = String(next.decided_date);
    next.decided_at = /^\d{4}-\d{2}-\d{2}$/.test(d)
      ? new Date(`${d}T00:00:00+09:00`).toISOString()
      : d;
  }
  if (!next.created_by) next.created_by = `${os.hostname()}|${ROOT()}`;
  if (!next.match || typeof next.match !== 'object') next.match = {};
  if (!next.match.to && next.to[0]) next.match.to = next.to[0];
  if (!next.match.after && next.decided_at) next.match.after = next.decided_at;
  next.body_path = next.body_path ?? null;
  next.to_name = next.to_name ?? next.client ?? null;
  next.reply_to_message_id = next.reply_to_message_id ?? null;
  next.chat_id = next.chat_id ?? null;
  next.from = next.from || 'seisaku-team@orgiast.jp';
  next.last_checked_at = next.last_checked_at ?? null;
  next.last_check_error = next.last_check_error ?? null;
  next.sent_message_id = next.sent_message_id ?? null;
  next.deadline = next.deadline ?? null;
  next.decided_by = next.decided_by ?? null;
  return next;
}

export function normalizeItem(item) {
  return migrateItem({
    to: [],
    cc: [],
    body_path: null,
    reply_to_message_id: null,
    reply_to_note: null,
    thread_id: null,
    gmail_draft_id: null,
    chat_id: null,
    from: 'seisaku-team@orgiast.jp',
    channel: 'email',
    urgent: false,
    status: '承認待ち',
    status_reason: '',
    evidence: [],
    history: [],
    unconfirmed_checks: 0,
    last_checked_at: null,
    last_check_error: null,
    sent_message_id: null,
    match: {},
    ...item,
  });
}

export function migrateLedger(ledger) {
  const items = (ledger.items || []).map(migrateItem);
  return {
    ...ledger,
    schema: SCHEMA,
    generated_at: ledger.generated_at || nowIso(),
    items,
  };
}

export function loadLedger(file = LEDGER()) {
  if (!fs.existsSync(file)) return { schema: SCHEMA, generated_at: nowIso(), items: [] };
  return migrateLedger(readJson(file));
}

export function saveLedger(ledger, file = LEDGER()) {
  const next = migrateLedger({ ...ledger, generated_at: nowIso() });
  atomicJson(file, next);
  return next;
}

function inboxDirs(ledgerFile = LEDGER()) {
  const dirs = [
    path.join(path.dirname(ledgerFile), 'inbox'),
    path.join(ROOT(), 'inbox'),
    GB_INBOX(),
  ];
  return [...new Set(dirs.map((d) => path.resolve(d)))];
}

export function ingest(ledger, inbox) {
  const dirs = inbox ? [inbox] : inboxDirs();
  let count = 0;
  const byId = new Map(ledger.items.map((x) => [x.id, x]));
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const done = path.join(dir, 'done');
    fs.mkdirSync(done, { recursive: true });
    for (const name of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const file = path.join(dir, name);
      const raw = normalizeItem(readJson(file));
      if (!raw.id) throw new Error(`inbox item id missing: ${file}`);
      const existing = byId.get(raw.id);
      if (!existing) {
        ledger.items.push(raw);
        byId.set(raw.id, raw);
        count += 1;
      } else {
        // 既存は追記せずフィールド補完
        for (const [k, v] of Object.entries(raw)) {
          if (existing[k] == null || existing[k] === '' || (Array.isArray(existing[k]) && existing[k].length === 0)) {
            existing[k] = v;
          }
        }
        Object.assign(existing, migrateItem(existing));
      }
      fs.renameSync(file, path.join(done, name));
    }
  }
  return count;
}

export function addItem(ledger, raw) {
  const item = normalizeItem(raw);
  if (!item.id) throw new Error('id required');
  if (!CHANNELS.includes(item.channel)) throw new Error(`invalid channel: ${item.channel}`);
  if (!STATUSES.includes(item.status)) throw new Error(`invalid status: ${item.status}`);
  const idx = ledger.items.findIndex((x) => x.id === item.id);
  if (idx >= 0) {
    const existing = ledger.items[idx];
    for (const [k, v] of Object.entries(item)) {
      if (existing[k] == null || existing[k] === '' || (Array.isArray(existing[k]) && existing[k].length === 0)) {
        existing[k] = v;
      }
    }
    ledger.items[idx] = migrateItem(existing);
    return { added: false, item: ledger.items[idx] };
  }
  ledger.items.push(item);
  return { added: true, item };
}

export function bodyText(item) {
  if (!item.body_path || !fs.existsSync(item.body_path)) return '';
  const raw = fs.readFileSync(item.body_path, 'utf8').replace(/^\uFEFF/, '');
  const split = raw.split(/^---\s*$/m);
  return (split.length > 1 ? split.slice(1).join('\n---\n') : raw).trim();
}

function looksSentMarker(dir) {
  const markers = ['SEND-REPORT.md', 'DONE-SEND.txt', 'SEND-RESULT.json'];
  for (const name of markers) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    if (/送信済|sent|delivered|ok|success|送信完了/i.test(text)) return true;
  }
  return false;
}

export function scanDraftFiles(ledger, {
  root = GB_REPORTS(),
  now = Date.now(),
} = {}) {
  if (!fs.existsSync(root)) return { registered: 0 };
  const knownPaths = new Set(
    ledger.items.map((x) => x.body_path).filter(Boolean).map((p) => path.resolve(p)),
  );
  const excludeCards = path.resolve(path.join(root, 'unsent-ledger', 'cards'));
  let registered = 0;
  const depth1 = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
  const folders = [];
  for (const d of depth1) {
    const p = path.join(root, d.name);
    folders.push(p);
    try {
      for (const d2 of fs.readdirSync(p, { withFileTypes: true })) {
        if (d2.isDirectory()) folders.push(path.join(p, d2.name));
      }
    } catch { /* skip */ }
  }
  for (const folder of folders) {
    let st;
    try { st = fs.statSync(folder); } catch { continue; }
    if (now - st.mtimeMs > SEVEN_DAYS_MS) continue;
    let names;
    try { names = fs.readdirSync(folder); } catch { continue; }
    const files = [];
    for (const name of names) {
      if (/^DRAFT-.*\.(txt|md)$/i.test(name) || /^BODY-.*\.md$/i.test(name)) {
        files.push(path.join(folder, name));
      }
      if (name === 'cards' && path.resolve(path.join(folder, 'cards')) !== excludeCards) {
        const cardsDir = path.join(folder, 'cards');
        try {
          for (const c of fs.readdirSync(cardsDir).filter((x) => x.endsWith('.json'))) {
            files.push(path.join(cardsDir, c));
          }
        } catch { /* skip */ }
      }
    }
    const sentLikely = looksSentMarker(folder);
    for (const file of files) {
      const resolved = path.resolve(file);
      if (knownPaths.has(resolved)) continue;
      if (resolved.startsWith(excludeCards + path.sep) || resolved === excludeCards) continue;
      const id = hashId(resolved);
      if (ledger.items.some((x) => x.id === id)) {
        knownPaths.add(resolved);
        continue;
      }
      const item = normalizeItem({
        id,
        channel: 'other',
        internal: false,
        to: [],
        subject: path.basename(file),
        body_path: resolved,
        case: `下書き自動検出 ${path.basename(folder)}`,
        created_by: `${os.hostname()}|scanDraftFiles`,
        decided_at: nowIso(),
        status: sentLikely ? '送信未確認' : '止まった',
        status_reason: sentLikely ? '送信済みマーカーあり・照合待ち' : '下書きのみで台帳未登録',
        evidence: [resolved],
      });
      if (item.status === '止まった' && !item.history.length) {
        setStatus(item, '止まった', item.status_reason, { by: 'scanDraftFiles' });
      } else if (item.status === '送信未確認' && !item.history.length) {
        item.history.push({ at: nowIso(), status: '送信未確認', reason: item.status_reason, by: 'scanDraftFiles' });
      }
      ledger.items.push(item);
      knownPaths.add(resolved);
      registered += 1;
    }
  }
  return { registered };
}

export async function scanGmailDrafts(ledger, {
  listDrafts,
  users = ['seisaku-team@orgiast.jp', 'kim@orgiast.jp'],
  now = Date.now(),
} = {}) {
  if (!listDrafts) return { registered: 0, errors: [] };
  const known = new Set(ledger.items.map((x) => x.gmail_draft_id).filter(Boolean));
  let registered = 0;
  const errors = [];
  for (const user of users) {
    try {
      const drafts = await listDrafts(user);
      for (const d of drafts || []) {
        const id = d.id || d.gmail_draft_id;
        if (!id || known.has(id)) continue;
        const createdMs = Number(d.createdMs || d.internalDate || 0);
        if (createdMs && now - createdMs < TWO_HOURS_MS) continue;
        const item = normalizeItem({
          id: `gmail-draft-${id}`,
          channel: 'email',
          gmail_draft_id: id,
          from: user,
          to: asArray(d.to),
          subject: d.subject || '(Gmail下書き)',
          case: d.subject || 'Gmail下書き',
          decided_at: createdMs ? new Date(createdMs).toISOString() : nowIso(),
          status: '止まった',
          status_reason: '台帳未登録のGmail下書き',
          evidence: [`gmail-draft:${user}:${id}`],
        });
        setStatus(item, '止まった', '台帳未登録のGmail下書き', { by: 'scanGmailDrafts' });
        ledger.items.push(item);
        known.add(id);
        registered += 1;
      }
    } catch (error) {
      errors.push({ user, message: error.message });
      // 照合エラーとして ALERT に載せるため、ダミー項目ではなく run 側で集約
    }
  }
  return { registered, errors };
}

async function checkEmail(item, search) {
  const target = item.match?.to || item.to?.[0];
  const after = item.match?.after || item.decided_at;
  if (!target || target === '不明' || !after) {
    item.last_check_error = 'match.to または match.after が未設定';
    return false;
  }
  const epoch = Math.floor(new Date(after).getTime() / 1000);
  if (!Number.isFinite(epoch)) throw new Error(`invalid match.after: ${after}`);
  const result = await search({
    user: item.from || 'seisaku-team@orgiast.jp',
    query: `in:sent to:${target} after:${epoch}`,
    max: 50,
  });
  const needles = item.match?.subject_any
    || (item.subject && item.subject !== '不明' ? [item.subject] : []);
  const found = (result.messages || []).find((m) => !needles.length || needles.some((n) => String(m.subject).includes(n)));
  if (found) {
    setStatus(item, '送信済み', 'Gmail照合一致', { by: 'check' });
    item.sent_message_id = found.id;
    item.thread_id ||= found.threadId || null;
    item.last_check_error = null;
    return true;
  }
  return false;
}

async function checkChat(item, reader) {
  const chatId = item.chat_id || item.match?.chat_id;
  if (!chatId) {
    item.last_check_error = 'chat_id 未設定';
    return false;
  }
  const afterMs = new Date(item.match?.after || item.decided_at || 0).getTime();
  const body = bodyText(item);
  const needles = item.match?.needles?.length
    ? item.match.needles
    : [body.slice(0, 40)].filter(Boolean);
  const messages = await reader(chatId, { afterMs });
  const found = (messages || []).find((m) => {
    const ts = new Date(m.timestamp || m.ts || m.sentAt || 0).getTime();
    if (afterMs && Number.isFinite(afterMs) && ts && ts < afterMs) return false;
    const text = String(m.text || m.body || m.content || '');
    return !needles.length || needles.some((n) => n && text.includes(n));
  });
  if (found) {
    setStatus(item, '送信済み', 'チャット照合一致', { by: 'check' });
    item.sent_message_id = found.id || found.messageID || null;
    item.last_check_error = null;
    return true;
  }
  return false;
}

export async function check(ledger, search = searchGmail, { reader } = {}) {
  const chatReader = reader || (async (chatId, { afterMs } = {}) => {
    const { listMessages } = await import('./beeper-api.mjs');
    const res = await listMessages(String(chatId), { limit: 50 });
    const items = res?.items || res?.messages || res || [];
    return (Array.isArray(items) ? items : []).filter((m) => {
      const ts = new Date(m.timestamp || m.ts || 0).getTime();
      return !afterMs || !ts || ts >= afterMs;
    });
  });

  ledger.items = (ledger.items || []).map(migrateItem);

  for (const item of ledger.items.filter((x) => isPending(x))) {
    item.last_checked_at = nowIso();
    delete item.last_check_error;
    try {
      let found = false;
      if (item.channel === 'email' || !item.channel) {
        found = await checkEmail(item, search);
      } else if (['discord', 'beeper', 'line'].includes(item.channel)) {
        found = await checkChat(item, chatReader);
      }
      if (!found && item.status === '送信未確認') {
        item.unconfirmed_checks = Number(item.unconfirmed_checks || 0) + 1;
        if (item.unconfirmed_checks >= 3) {
          setStatus(item, '止まった', '送信未確認が3時間解消しない', { by: 'check' });
        }
      }
    } catch (error) {
      item.last_check_error = error.message;
      // status は変えない
    }
  }
}

export async function autoSend(ledger, { dryRun = true, sender, reader } = {}) {
  const results = [];
  for (const item of ledger.items.filter((x) => x.status === '自動送信待ち')) {
    // 社外は関数レベルで拒否（dry-run 出力にも出さない）
    if (item.internal !== true) {
      continue;
    }
    if (!hasKimDecision(item)) {
      results.push({ id: item.id, skipped: true, reason: 'hasKimDecision=false' });
      continue;
    }
    if (!['discord', 'beeper'].includes(item.channel)) {
      results.push({ id: item.id, skipped: true, reason: `channel=${item.channel}` });
      continue;
    }
    const body = bodyText(item);
    const preview = { id: item.id, to: item.to, chat_id: item.chat_id, subject: item.subject, body: body.slice(0, 200) };
    if (dryRun) {
      results.push({ id: item.id, dryRun: true, ...preview });
      continue;
    }
    try {
      if (reader) {
        const already = await checkChat({ ...item }, reader);
        if (already) {
          results.push({ id: item.id, alreadySent: true });
          continue;
        }
      }
      if (!sender) throw new Error('sender required for live send');
      const sent = await sender(item, body);
      const ok = reader ? await checkChat(item, reader) : Boolean(sent);
      if (ok || sent) {
        setStatus(item, '送信済み', 'autoSend', { by: 'autoSend' });
        item.sent_message_id = sent?.id || item.sent_message_id || null;
        results.push({ id: item.id, sent: true });
      } else {
        setStatus(item, '止まった', '自動送信後の読み戻し失敗', { by: 'autoSend' });
        results.push({ id: item.id, sent: false, reason: 'readback failed' });
      }
    } catch (error) {
      setStatus(item, '止まった', `自動送信失敗: ${error.message}`, { by: 'autoSend' });
      results.push({ id: item.id, sent: false, reason: error.message });
    }
  }
  return results;
}

function elapsedLabel(iso) {
  if (!iso) return '不明';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return '0分';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}分`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}時間`;
  return `${Math.floor(h / 24)}日`;
}

function isUrgentDeadline(item, now = Date.now()) {
  if (!item.deadline) return false;
  const dl = new Date(item.deadline).getTime();
  if (!Number.isFinite(dl)) return false;
  return dl - now <= TWO_HOURS_MS && isPending(item);
}

function formatItemBlock(item) {
  const lines = [
    `### ${item.id}`,
    `- 宛先: ${(item.to || []).join(', ') || '(なし)'} ${item.to_name ? `(${item.to_name})` : ''}`,
    `- 差出人: ${item.from || ''}`,
    `- 件名: ${item.subject || ''}`,
    `- 経路: ${item.channel || ''} / ${item.internal ? '社内' : '社外'}`,
    `- 状態: ${item.status}${item.status_reason ? `（${item.status_reason}）` : ''}`,
    `- 案件: ${item.case || item.client || ''}`,
    `- 期限: ${item.deadline || 'なし'}`,
    `- 決まってから: ${elapsedLabel(item.decided_at || (item.decided_date ? `${item.decided_date}T00:00:00+09:00` : null))}`,
    `- 返信元ID: ${item.reply_to_message_id || 'なし'}`,
    `- chat_id: ${item.chat_id || 'なし'}`,
    `- body_path: ${item.body_path || 'なし'}`,
    '',
    '```',
    bodyText(item) || '(本文なし)',
    '```',
    '',
  ];
  return lines.join('\n');
}

export function buildAlert(ledger, { checkErrors = [], now = new Date() } = {}) {
  const pending = ledger.items.filter(isPending);
  const priority = [];
  const stopped = [];
  const checkErr = [];
  const unsent = [];

  for (const item of pending) {
    if (isUrgentDeadline(item, now.getTime())) priority.push(item);
    else if (item.status === '止まった') stopped.push(item);
    else unsent.push(item);
  }
  for (const item of ledger.items) {
    if (item.last_check_error) checkErr.push(item);
  }
  for (const err of checkErrors) {
    checkErr.push({
      id: `check-error-${err.user || 'x'}`,
      to: [],
      from: err.user || '',
      subject: '照合エラー',
      channel: 'email',
      internal: true,
      status: '照合エラー',
      status_reason: err.message,
      last_check_error: err.message,
      body_path: null,
      case: '照合ジョブ',
      decided_at: null,
      deadline: null,
      chat_id: null,
      reply_to_message_id: null,
    });
  }

  const stamp = jstStamp(now);
  const total = priority.length + stopped.length + checkErr.length + unsent.length;
  const sections = [
    `# 未送信アラート`,
    `生成: ${stamp}（JST）`,
    `件数: ${total}件（最優先 ${priority.length} / 止まった ${stopped.length} / 照合エラー ${checkErr.length} / 未送信 ${unsent.length}）`,
    '',
    '## 【最優先】',
    priority.length ? priority.map(formatItemBlock).join('\n') : '（0件）',
    '',
    '## 【止まった】',
    stopped.length
      ? stopped.map((item) => {
        const stoppedAt = [...(item.history || [])].reverse().find((h) => h.status === '止まった')?.at
          || item.last_checked_at
          || item.decided_at;
        return `${formatItemBlock(item)}- 止まってから: ${elapsedLabel(stoppedAt)}\n`;
      }).join('\n')
      : '（0件）',
    '',
    '## 【照合エラー】',
    checkErr.length
      ? checkErr.map((item) => `### ${item.id}\n- 理由: ${item.last_check_error || item.status_reason}\n- 宛先: ${(item.to || []).join(', ')}\n`).join('\n')
      : '（0件）',
    '',
    '## 【未送信】',
    unsent.length ? unsent.map(formatItemBlock).join('\n') : '（0件）',
    '',
  ];
  return {
    markdown: sections.join('\n'),
    alerts: [
      ...priority.map((x) => ({ ...x, alert_bucket: '最優先' })),
      ...stopped.map((x) => ({ ...x, alert_bucket: '止まった' })),
      ...checkErr.map((x) => ({ ...x, alert_bucket: '照合エラー' })),
      ...unsent.map((x) => ({ ...x, alert_bucket: '未送信' })),
    ],
    counts: {
      total,
      priority: priority.length,
      stopped: stopped.length,
      checkErrors: checkErr.length,
      unsent: unsent.length,
    },
  };
}

export function exportLedger(ledger, destinations, { checkErrors = [] } = {}) {
  const dirs = destinations || [
    process.env.UNSENT_LEDGER_EXPORT_DIR || DEFAULT_EXPORT_DIR(),
  ];
  const built = buildAlert(ledger, { checkErrors });
  for (const dir of dirs) {
    fs.mkdirSync(path.join(dir, 'cards'), { recursive: true });
    atomicText(path.join(dir, 'ALERT.md'), built.markdown);
    atomicJson(path.join(dir, 'alerts.json'), {
      generated_at: nowIso(),
      counts: built.counts,
      items: built.alerts.map((x) => ({
        id: x.id,
        alert_bucket: x.alert_bucket,
        status: x.status,
        to: x.to,
        to_name: x.to_name,
        subject: x.subject,
        channel: x.channel,
        internal: x.internal,
        deadline: x.deadline,
        status_reason: x.status_reason,
        last_check_error: x.last_check_error || null,
      })),
    });
    atomicJson(path.join(dir, 'unsent-ledger.json'), {
      ...ledger,
      generated_at: nowIso(),
      items: ledger.items.filter(isPending),
    });
    for (const item of ledger.items.filter(isPending)) {
      const safe = String(item.id).replace(/[^a-zA-Z0-9_.-]/g, '_');
      atomicJson(path.join(dir, 'cards', `${safe}.json`), {
        ...item,
        body_text: bodyText(item),
      });
    }
  }
  patchSummary(built);
  return built.counts.total;
}

export function patchSummary(built, summaryPath = path.join(os.homedir(), 'gb-reports', 'session-status', 'SUMMARY.md')) {
  const block = [
    '<!-- UNSENT-ALERT-START -->',
    '## 未送信アラート',
    `- 生成: ${jstStamp()}`,
    `- 件数: ${built.counts.total}件（最優先 ${built.counts.priority} / 止まった ${built.counts.stopped} / 照合エラー ${built.counts.checkErrors} / 未送信 ${built.counts.unsent}）`,
    `- 詳細: ${path.join(process.env.UNSENT_LEDGER_EXPORT_DIR || DEFAULT_EXPORT_DIR(), 'ALERT.md')}`,
    '<!-- UNSENT-ALERT-END -->',
    '',
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    let text = fs.existsSync(summaryPath) ? fs.readFileSync(summaryPath, 'utf8') : '';
    if (/<!-- UNSENT-ALERT-START -->[\s\S]*?<!-- UNSENT-ALERT-END -->/.test(text)) {
      text = text.replace(/<!-- UNSENT-ALERT-START -->[\s\S]*?<!-- UNSENT-ALERT-END -->\n?/, `${block}`);
    } else {
      text = `${block}${text}`;
    }
    atomicText(summaryPath, text);
  } catch {
    // SUMMARY 更新失敗は致命にしない
  }
}

export async function maybeNotifyStuck(ledger, {
  exportDir = process.env.UNSENT_LEDGER_EXPORT_DIR || DEFAULT_EXPORT_DIR(),
  notify = null,
  statePath = path.join(ROOT(), 'notify-state.json'),
  now = new Date(),
} = {}) {
  const ackDir = path.join(exportDir, 'ack');
  const built = buildAlert(ledger, { now });
  const targets = built.alerts.filter((x) => x.alert_bucket === '最優先' || x.alert_bucket === '止まった');
  if (!targets.length) return { notified: false, reason: 'no-targets' };

  let state = { streaks: {}, lastNotifyDate: null };
  try { if (fs.existsSync(statePath)) state = { ...state, ...readJson(statePath) }; } catch { /* */ }

  const day = now.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
  const unacked = [];
  for (const item of targets) {
    const ack = path.join(ackDir, `${item.id}.json`);
    if (fs.existsSync(ack)) {
      state.streaks[item.id] = 0;
      continue;
    }
    state.streaks[item.id] = Number(state.streaks[item.id] || 0) + 1;
    if (state.streaks[item.id] >= 2) unacked.push(item);
  }
  atomicJson(statePath, state);
  if (!unacked.length) return { notified: false, reason: 'streak<2' };
  if (state.lastNotifyDate === day) return { notified: false, reason: 'already-today' };

  const summary = `未送信アラート: ${unacked.length}件（${unacked.map((x) => x.to_name || x.to?.[0] || x.id).slice(0, 5).join('、')}…）期限あり ${unacked.filter((x) => x.deadline).length}件`;
  if (notify) {
    await notify(summary);
  } else {
    // tools/notify-kim.mjs は引数がそのまま本文。--help 禁止。kim-inbox 経路。
    const script = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'notify-kim.mjs');
    spawnSync(process.execPath, [script, summary], {
      windowsHide: true,
      timeout: 60_000,
      stdio: 'ignore',
    });
  }
  state.lastNotifyDate = day;
  atomicJson(statePath, state);
  return { notified: true, count: unacked.length };
}

function writeJobFailure(message) {
  const dir = process.env.UNSENT_LEDGER_EXPORT_DIR || DEFAULT_EXPORT_DIR();
  try {
    fs.mkdirSync(dir, { recursive: true });
    atomicText(path.join(dir, 'ALERT.md'), `# 未送信アラート\n生成: ${jstStamp()}\n件数: 0件\n\n照合ジョブ失敗: ${message}\n`);
    return;
  } catch {
    // fallthrough
  }
  try {
    const status = path.join(os.homedir(), 'gb-reports', 'session-status', 'STATUS-000.md');
    fs.mkdirSync(path.dirname(status), { recursive: true });
    fs.appendFileSync(status, `\n- ${jstStamp()} unsent-ledger 失敗: ${message}\n`);
  } catch {
    // ignore
  }
}

export async function run({
  doIngest = true,
  doCheck = true,
  doExport = true,
  doScanDrafts = true,
  doScanGmail = false,
  doAutoSend = false,
  dryRun = true,
  ledgerFile = LEDGER(),
  search,
  listDrafts,
  reader,
  sender,
  exportDirs,
} = {}) {
  try {
    let ledger = loadLedger(ledgerFile);
    const ingested = doIngest ? ingest(ledger) : 0;
    const draftScan = doScanDrafts ? scanDraftFiles(ledger) : { registered: 0 };
    let gmailScan = { registered: 0, errors: [] };
    if (doScanGmail && listDrafts) gmailScan = await scanGmailDrafts(ledger, { listDrafts });
    if (doCheck) await check(ledger, search || searchGmail, { reader });
    let autoSendResult = [];
    if (doAutoSend) autoSendResult = await autoSend(ledger, { dryRun, sender, reader });
    ledger = saveLedger(ledger, ledgerFile);
    const pending = doExport
      ? exportLedger(ledger, exportDirs, { checkErrors: gmailScan.errors || [] })
      : ledger.items.filter(isPending).length;
    if (doExport) await maybeNotifyStuck(ledger, { exportDir: (exportDirs && exportDirs[0]) || undefined });
    return {
      total: ledger.items.length,
      pending,
      ingested,
      draftScan,
      gmailScan,
      autoSendResult,
      statusCounts: Object.fromEntries(STATUSES.map((s) => [s, ledger.items.filter((x) => x.status === s).length])),
    };
  } catch (error) {
    writeJobFailure(error.message || String(error));
    throw error;
  }
}

export function markdown(items) {
  const e = (value) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
  return [
    '| # | 状態 | クライアント | 案件 | 宛先 | CC | 件名 | 決まった日 | 止まった理由 | 根拠 | 本文ファイル |',
    '|---:|---|---|---|---|---|---|---|---|---|---|',
    ...items.map((x, i) => `| ${i + 1} | ${e(x.status)} | ${e(x.client || x.to_name)} | ${e(x.case)} | ${e((x.to || []).join(', '))} | ${e((x.cc || []).join(', '))} | ${e(x.subject)} | ${e(x.decided_date || x.decided_at)} | ${e(x.status_reason || x.stop_reason)} | ${e((x.evidence || []).join(' / '))} | ${e(x.body_path)} |`),
    '',
  ].join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === 'add' && args.includes('--file')) {
    const file = args[args.indexOf('--file') + 1];
    const ledger = loadLedger();
    const result = addItem(ledger, readJson(file));
    saveLedger(ledger);
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const only = args.some((x) => ['--ingest', '--check', '--export'].includes(x));
  const dryRun = args.includes('--dry-run') || !args.includes('--send');
  const result = await run({
    doIngest: !only || args.includes('--ingest'),
    doCheck: !only || args.includes('--check'),
    doExport: !only || args.includes('--export'),
    doScanDrafts: !args.includes('--no-scan-drafts'),
    doScanGmail: args.includes('--scan-gmail'),
    doAutoSend: args.includes('--dry-run') || args.includes('--send') || args.includes('--auto-send'),
    dryRun,
  });
  console.log(JSON.stringify(result, null, 2));
}

if (isEntry(import.meta.url)) {
  main().catch((e) => {
    console.error(e.stack || e.message);
    process.exitCode = 1;
  });
}
              