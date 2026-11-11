#!/usr/bin/env node
/**
 * meeting-url-notice.mjs — 社外打合せの会議URL案内を自動送付・前日リマインド。
 *
 * 使い方:
 *   node tools/meeting-url-notice.mjs --dry-run
 *   node tools/meeting-url-notice.mjs --mode approve （既定、kim-inbox ask 経由）
 *   node tools/meeting-url-notice.mjs --mode auto （autoSendApproved 必須）
 *
 * DWD + 自己署名 JWT（Node 18+ / 標準 crypto と fetch、依存なし）。
 * gmail-draft.mjs と同じ認証経路を使う。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOUR = 3600000;
const JST = 9 * HOUR;
const STAFF_DOMAINS = ['orgiast.jp'];

// ── 日付・JST ユーティリティ (タイムゾーン非依存) ──

export function getJstParts(dateOrIso) {
  const date = typeof dateOrIso === 'number' ? new Date(dateOrIso) : new Date(dateOrIso);
  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map(p => [p.type, p.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    dow: parts.weekday,
    hour: String(parts.hour === '24' ? '00' : parts.hour).padStart(2, '0'),
    minute: String(parts.minute).padStart(2, '0'),
    numericHour: Number(parts.hour === '24' ? '0' : parts.hour),
  };
}

export function jstDate(date = new Date()) {
  const p = getJstParts(date);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

export function dayBounds(dateStr) {
  const start = Date.parse(`${dateStr}T00:00:00+09:00`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr) || !Number.isFinite(start)) throw new Error(`invalid date: ${dateStr}`);
  return { timeMin: new Date(start).toISOString(), timeMax: new Date(start + 86400000).toISOString() };
}

export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

export function save(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
}

// ── Calendar helpers ──

/** 予定に Google Meet リンクが含まれているか */
export function hasMeetLink(event) {
  if (event.hangoutLink) return true;
  if (event.conferenceData?.entryPoints?.some(ep => /meet\.google\.com/.test(ep.uri || ''))) return true;
  if (event.conferenceData?.videoEntryPoint?.uri) return true;
  const text = `${event.description || ''} ${event.location || ''}`;
  if (/https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i.test(text)) return true;
  return false;
}

/** Meet URL からコード (例: uis-taut-akx) を抽出 */
export function extractMeetCode(event) {
  const text = `${event.description || ''} ${event.location || ''} ${event.hangoutLink || ''} ${(event.conferenceData?.entryPoints || []).map(ep => ep.uri).join(' ')} ${event.conferenceData?.videoEntryPoint?.uri || ''}`;
  const m = text.match(/https?:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return m ? m[1].toLowerCase() : null;
}

/** Meet URL 全体を抽出 */
export function extractMeetUrl(event) {
  if (event.hangoutLink) return event.hangoutLink;
  if (event.conferenceData?.videoEntryPoint?.uri) return event.conferenceData.videoEntryPoint.uri;
  if (event.conferenceData?.entryPoints) {
    const ep = event.conferenceData.entryPoints.find(e => /meet\.google\.com/.test(e.uri || ''));
    if (ep) return ep.uri;
  }
  const text = `${event.description || ''} ${event.location || ''}`;
  const m = text.match(/https?:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i);
  return m ? m[0] : '';
}

/** 社外打合せ判定とフィルタ */
export function isTargetEvent(event) {
  if (event.status === 'cancelled') return false;
  if (!event.start?.dateTime || !event.end?.dateTime) return false;
  const summary = event.summary || '';
  if (!/様/u.test(summary)) return false;
  if (/社内|事前|準備|面談|定例|朝礼|改善会|📋|【自動】|私用/u.test(summary)) return false;
  return hasMeetLink(event);
}

// ── 社員判定 ──

export function isStaff(email, config) {
  if (!email || typeof email !== 'string') return true;
  const lower = email.toLowerCase().trim();
  if (STAFF_DOMAINS.some(d => lower.endsWith(`@${d}`))) return true;
  if (config.staffAddresses?.some(s => s.toLowerCase().trim() === lower)) return true;
  return false;
}

// ── 宛先特定 ──

export function extractEmail(from) {
  if (!from) return null;
  const m = from.match(/<([^>]+)>/) || from.match(/([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/);
  return m ? m[1].trim() : null;
}

export function extractDisplayName(from) {
  if (!from) return '';
  const m = from.match(/^([^<]+)</);
  return m ? m[1].replace(/["']/g, '').trim() : '';
}

export function extractCompanyName(summary) {
  if (!summary) return null;
  const m = summary.match(/(.+?)様/u);
  if (!m) return null;
  let name = m[1].trim();
  name = name.replace(/^(?:M\d*|G)\s*[:：]\s*/ui, '').trim();
  name = name.replace(/^[\s\u200B\uFEFF\uA000\u00A0]+/u, '').trim();
  name = name.replace(/\s*\([^)]*\)\s*$/u, '').trim();
  return name || null;
}

export function headerValue(payload, name) {
  const target = String(name).toLowerCase();
  const found = (payload?.headers || []).find(h => String(h.name).toLowerCase() === target);
  return found ? String(found.value) : '';
}

export function extractUniqueRecipients(thread, config) {
  const messages = thread.messages || [thread];
  const recipients = new Set();
  for (const msg of messages) {
    const payload = msg.payload || msg;
    const from = headerValue(payload, 'from') || msg.from;
    const to = headerValue(payload, 'to') || msg.to;
    const fromAddr = extractEmail(from);
    const toAddr = extractEmail(to);
    if (fromAddr && !isStaff(fromAddr, config)) recipients.add(fromAddr.toLowerCase());
    if (toAddr && !isStaff(toAddr, config)) recipients.add(toAddr.toLowerCase());
  }
  return [...recipients];
}

/**
 * 宛先特定: 優先順位 (a) 参加者 (b) meetコードを含む送信済みメール (c) 会社名マッチ
 */
export function identifyRecipient(event, config, { attendees = [], gmailMessages = [], recentThreads = [] } = {}) {
  // (a) 参加者から社員以外
  const externalAttendees = attendees.filter(a => {
    if (a.self || a.resource || !a.email) return false;
    return !isStaff(a.email, config);
  });
  if (externalAttendees.length === 1) {
    return { method: 'a', email: externalAttendees[0].email.toLowerCase(), displayName: externalAttendees[0].displayName || '' };
  }
  if (externalAttendees.length > 1) {
    const uniqueExt = [...new Set(externalAttendees.map(a => a.email.toLowerCase()))];
    if (uniqueExt.length === 1) {
      return { method: 'a', email: uniqueExt[0], displayName: externalAttendees[0].displayName || '' };
    }
  }

  // (b) meetコードを含むメールの相手
  const meetCode = extractMeetCode(event);
  if (meetCode && gmailMessages.length > 0) {
    const candidates = new Set();
    let sampleMsg = null;
    for (const msg of gmailMessages) {
      const payload = msg.payload || msg;
      const from = extractEmail(msg.from || headerValue(payload, 'from'));
      const to = extractEmail(msg.to || headerValue(payload, 'to'));
      if (from && !isStaff(from, config)) { candidates.add(from.toLowerCase()); sampleMsg ||= msg; }
      if (to && !isStaff(to, config)) { candidates.add(to.toLowerCase()); sampleMsg ||= msg; }
    }
    if (candidates.size === 1) {
      const email = [...candidates][0];
      const displayName = sampleMsg ? extractDisplayName(sampleMsg.from || headerValue(sampleMsg.payload || sampleMsg, 'from')) : '';
      return { method: 'b', email, displayName, gmailMessageId: sampleMsg?.id };
    }
  }

  // (c) 会社名 → 直近60日のスレッドで相手が1社だけ
  const companyName = extractCompanyName(event.summary);
  if (companyName && recentThreads.length > 0) {
    const candidates = new Set();
    for (const thread of recentThreads) {
      const emails = extractUniqueRecipients(thread, config);
      for (const e of emails) candidates.add(e.toLowerCase());
    }
    if (candidates.size === 1) {
      const email = [...candidates][0];
      return { method: 'c', email, displayName: '' };
    }
  }
  return { method: null, email: null, displayName: '' };
}

// ── 時刻判定 ──

export function shouldSendReminder(event, now = Date.now()) {
  const start = Date.parse(event.start?.dateTime || event.start);
  if (!Number.isFinite(start)) return false;
  const jstStartParts = getJstParts(start);
  const startJstDayMs = Date.parse(`${jstStartParts.year}-${String(jstStartParts.month).padStart(2, '0')}-${String(jstStartParts.day).padStart(2, '0')}T00:00:00+09:00`);
  const prevDay10amJstMs = startJstDayMs - 86400000 + 10 * HOUR;
  return now >= prevDay10amJstMs && now < start;
}

export function isQuietHours(now = Date.now()) {
  const h = getJstParts(now).numericHour;
  return h < 8 || h >= 21;
}

// ── 件名・本文テンプレート ──

export function formatSubject(kind, event) {
  const start = Date.parse(event.start?.dateTime || event.start);
  const p = getJstParts(start);
  const date = `${p.month}月${p.day}日`;
  const time = `${p.hour}:${p.minute}`;
  if (kind === 'firstNotice') {
    return `【会議URLのご案内】${date}（${p.dow}）${time}〜 オンラインお打ち合わせ（株式会社オージャスト）`;
  }
  return `【リマインド】明日${date}（${p.dow}）${time}〜 オンラインお打ち合わせ（株式会社オージャスト）`;
}

export function buildAddressName(recipient, companyName) {
  if (recipient?.displayName && recipient.displayName.includes('様')) {
    if (companyName && !recipient.displayName.includes(companyName)) {
      return `${companyName}\n${recipient.displayName}`;
    }
    return recipient.displayName;
  }
  if (companyName) {
    return `${companyName}\nご担当者様`;
  }
  return 'ご担当者様';
}

export function formatBody(kind, event, config, addressName) {
  const meetUrl = extractMeetUrl(event);
  const start = Date.parse(event.start?.dateTime || event.start);
  const p = getJstParts(start);
  const date = `${p.month}月${p.day}日`;
  const time = `${p.hour}:${p.minute}`;
  const isReBooth = /Reブース/ui.test(event.summary || '');
  const signature = isReBooth ? config.signatures.rebooth : config.signatures.default;
  const template = kind === 'firstNotice' ? config.templates.firstNotice : config.templates.reminder;
  let body = template.body;
  body = body.replace(/\{addressName\}/g, addressName || '');
  body = body.replace(/\{date\}/g, date);
  body = body.replace(/\{dow\}/g, p.dow);
  body = body.replace(/\{time\}/g, time);
  body = body.replace(/\{meetUrl\}/g, meetUrl);
  body = body.replace(/\{signature\}/g, signature);
  return body;
}

// ── 送付済み判定 ──

export function buildLedgerKey(meetCode, email, kind) {
  return `${meetCode}:${email}:${kind}`;
}

export function checkLedgerSent(ledger, meetCode, email, kind) {
  return ledger.some(e => e.key === buildLedgerKey(meetCode, email, kind));
}

export function isReminderSubject(subject) {
  return /リマインド/u.test(subject);
}

export function isNoticeSubject(subject) {
  return /会議URLのご案内/u.test(subject);
}

/**
 * Gmail の送信済みメール・下書きを検索して送付済み判定。
 * 戻り値: { firstNoticeSent, reminderSent, existingDraftId, queryError }
 */
export async function checkGmailSent({ meetCode, recipientEmail, gmailChecker, draftChecker }) {
  try {
    const query = `in:sent to:${recipientEmail} ${meetCode}`;
    const messages = await gmailChecker(query);
    let gmailFirst = false, gmailReminder = false;
    for (const msg of messages) {
      const payload = msg.payload || msg;
      const subject = headerValue(payload, 'subject') || msg.subject || '';
      if (isNoticeSubject(subject)) gmailFirst = true;
      if (isReminderSubject(subject)) gmailReminder = true;
    }
    let existingDraftId = null;
    if (draftChecker) {
      const drafts = await draftChecker(recipientEmail, meetCode);
      if (drafts && drafts.length > 0) {
        existingDraftId = drafts[0].id;
      }
    }
    return { firstNoticeSent: gmailFirst, reminderSent: gmailReminder, existingDraftId, queryError: null };
  } catch (e) {
    return { firstNoticeSent: true, reminderSent: true, existingDraftId: null, queryError: e.message };
  }
}

// ── MIME/Raw Message ──

export function buildRawMessage({ from, to, subject, body, inReplyTo, references }) {
  const b64url = value => Buffer.from(value).toString('base64url');
  const chunks = [];
  let chunk = '';
  for (const char of subject) {
    if (Buffer.byteLength(chunk + char) > 42) { chunks.push(chunk); chunk = ''; }
    chunk += char;
  }
  chunks.push(chunk);
  const encodedSubject = chunks.map(s => `=?UTF-8?B?${Buffer.from(s).toString('base64')}?=`).join('\r\n ');
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${encodedSubject}`,
    ...(inReplyTo ? [`In-Reply-To: ${inReplyTo}`, `References: ${references || inReplyTo}`] : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
  ];
  const encodedBody = Buffer.from(body.replace(/\r\n|\r|\n/g, '\r\n')).toString('base64');
  return b64url(`${headers.join('\r\n')}\r\n\r\n${(encodedBody.match(/.{1,76}/g) || []).join('\r\n')}\r\n`);
}

// ── メインロジック ──

export async function processEvents({ events, config, ledger = [], now = Date.now(), deps }) {
  const results = [];

  for (const event of Object.values(events)) {
    const meetCode = extractMeetCode(event);
    const start = Date.parse(event.start?.dateTime || event.start);
    if (!meetCode || !Number.isFinite(start)) continue;
    if (start < now) continue; // 過去の予定

    const base = { meetCode, summary: event.summary, start: event.start.dateTime || event.start };

    // 宛先特定
    const attendees = event.attendees || [];
    const ctx = (deps.contextFor ? await deps.contextFor(event) : {}) || {};
    const recipient = identifyRecipient(event, config, { attendees, gmailMessages: ctx.gmailMessages || [], recentThreads: ctx.recentThreads || [] });
    if (!recipient.email) {
      results.push({ ...base, recipient: null, judgment: 'needs_recipient' });
      continue;
    }

    // 開始2時間前チェック
    if (now > start - 2 * HOUR) {
      results.push({ ...base, recipient: recipient.email, judgment: 'too_late' });
      continue;
    }

    // 深夜抑止
    if (isQuietHours(now)) {
      results.push({ ...base, recipient: recipient.email, judgment: 'quiet_hours' });
      continue;
    }

    // 送付済みチェック
    const gmail = await deps.checkGmail({ meetCode, recipientEmail: recipient.email });
    if (gmail.queryError) {
      results.push({ ...base, recipient: recipient.email, judgment: 'gmail_query_failed', reason: gmail.queryError });
      continue;
    }

    const companyName = extractCompanyName(event.summary);
    const addressName = buildAddressName(recipient, companyName);

    const alreadyFirst = gmail.firstNoticeSent || checkLedgerSent(ledger, meetCode, recipient.email, 'firstNotice');
    const alreadyReminder = gmail.reminderSent || checkLedgerSent(ledger, meetCode, recipient.email, 'reminder');
    const remind = shouldSendReminder(event, now);

    if (!alreadyFirst) {
      const subject = formatSubject('firstNotice', event);
      const body = formatBody('firstNotice', event, config, addressName);
      const r = await deps.processEvent({
        kind: 'firstNotice', meetCode, recipientEmail: recipient.email, subject, body, from: config.teamEmail, createdAt: new Date().toISOString(), existingDraftId: gmail.existingDraftId,
      });
      results.push({ ...base, recipient: recipient.email, ...r });

    } else if (remind && !alreadyReminder) {
      if (deps.getFirstSentAt) {
        const sentAt = deps.getFirstSentAt(meetCode, recipient.email, ledger);
        if (sentAt > 0 && now - sentAt < 24 * HOUR) {
          results.push({ ...base, recipient: recipient.email, judgment: 'reminder_skipped', reason: '初回案内から24時間以内' });
          continue;
        }
      }
      const subject = formatSubject('reminder', event);
      const body = formatBody('reminder', event, config, addressName);
      const r = await deps.processEvent({
        kind: 'reminder', meetCode, recipientEmail: recipient.email, subject, body, from: config.teamEmail, createdAt: new Date().toISOString(), existingDraftId: gmail.existingDraftId,
      });
      results.push({ ...base, recipient: recipient.email, ...r });

    } else {
      results.push({ ...base, recipient: recipient.email, judgment: 'already_sent' });
    }
  }

  return results;
}

// ── 本番依存の実装 ──

async function loadCalendarEvents(config) {
  const { getDriveToken } = await import('./lib/drive-auth.mjs');
  const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/calendar.readonly', impersonate: config.teamEmail });

  async function api(url, signal) {
    const s = signal || AbortSignal.timeout(30000);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: s });
    if (!res.ok) throw new Error(`Calendar API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  const calList = await api('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250&showHidden=true');
  const targetIds = (calList.items || []).filter(c => c.primary || c.id === config.teamEmail || c.id === config.userEmail).map(c => c.id);
  const eventsByMeetCode = {};
  const now = Date.now();
  const endDate = dayBounds(jstDate(now + 14 * 86400000)).timeMax;

  for (const calId of [...new Set(targetIds)]) {
    const params = new URLSearchParams({
      timeMin: dayBounds(jstDate(now)).timeMin,
      timeMax: endDate,
      singleEvents: 'true',
      maxResults: '2500',
    });
    try {
      const data = await api(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`);
      for (const event of data.items || []) {
        if (!isTargetEvent(event)) continue;
        const code = extractMeetCode(event);
        if (!code) continue;
        if (!eventsByMeetCode[code] || (event.summary?.length || 0) > (eventsByMeetCode[code].summary?.length || 0)) {
          eventsByMeetCode[code] = { ...event, calendarId: calId };
        }
      }
    } catch { /* skip errored calendar */ }
  }
  return eventsByMeetCode;
}

function createProductionDeps({ mode, dryRun, config, ledger }) {
  return {
    contextFor: async (event) => {
      const meetCode = extractMeetCode(event);
      const companyName = extractCompanyName(event.summary);
      const gmailMessages = [];
      const recentThreads = [];
      try {
        const { getDriveToken } = await import('./lib/drive-auth.mjs');
        const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/gmail.readonly', impersonate: config.teamEmail });
        if (meetCode) {
          const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(meetCode)}&maxResults=10`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
          });
          if (res.ok) {
            const list = await res.json();
            for (const stub of (list.messages || []).slice(0, 5)) {
              const msgRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${stub.id}?format=full`, {
                headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
              });
              if (msgRes.ok) gmailMessages.push(await msgRes.json());
            }
          }
        }
        if (companyName && gmailMessages.length === 0) {
          const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads?q=${encodeURIComponent(companyName)}&maxResults=5`, {
            headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
          });
          if (res.ok) {
            const list = await res.json();
            for (const stub of (list.threads || []).slice(0, 3)) {
              const thRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${stub.id}`, {
                headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
              });
              if (thRes.ok) recentThreads.push(await thRes.json());
            }
          }
        }
      } catch { /* continue with available info */ }
      return { gmailMessages, recentThreads };
    },

    checkGmail: async ({ meetCode, recipientEmail }) => {
      const query = `in:sent to:${recipientEmail} ${meetCode}`;
      try {
        const { getDriveToken } = await import('./lib/drive-auth.mjs');
        const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/gmail.readonly', impersonate: config.teamEmail });
        const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=10`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
        });
        const list = await res.json();
        const messages = [];
        for (const stub of (list.messages || []).slice(0, 5)) {
          try {
            const msg = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${stub.id}?format=full`, {
              headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
            });
            if (msg.ok) messages.push(await msg.json());
          } catch { /* skip */ }
        }

        // 下書きも確認
        const draftRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts`, {
          headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
        });
        const matchingDrafts = [];
        if (draftRes.ok) {
          const draftList = await draftRes.json();
          for (const d of (draftList.drafts || []).slice(0, 20)) {
            try {
              const dDetail = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${d.id}?format=full`, {
                headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
              });
              if (dDetail.ok) {
                const draftData = await dDetail.json();
                const headers = draftData.message?.payload?.headers || [];
                const to = (headers.find(h => h.name.toLowerCase() === 'to')?.value || '').toLowerCase();
                if (to.includes(recipientEmail.toLowerCase())) {
                  matchingDrafts.push({ id: d.id, ...draftData });
                }
              }
            } catch { /* skip */ }
          }
        }

        return await checkGmailSent({
          meetCode, recipientEmail,
          gmailChecker: async () => messages,
          draftChecker: async () => matchingDrafts,
        });
      } catch (e) {
        return { firstNoticeSent: true, reminderSent: true, existingDraftId: null, queryError: e.message };
      }
    },

    processEvent: async ({ kind, meetCode, recipientEmail, subject, body, from, existingDraftId }) => {
      if (dryRun) {
        return {
          judgment: existingDraftId ? 'draft_exists' : (kind === 'firstNotice' ? 'needs_send' : 'needs_reminder'),
          kind, subject, existingDraftId: existingDraftId || null, bodyPreview: body.slice(0, 200),
        };
      }
      if (mode === 'approve') {
        let draftId = existingDraftId;
        if (!draftId) {
          const { createDraft } = await import('./gmail-draft.mjs');
          const raw = buildRawMessage({ from, to: recipientEmail, subject, body });
          const draft = await createDraft({ user: from, raw });
          draftId = draft.id;
        }
        ledger.push({ key: buildLedgerKey(meetCode, recipientEmail, kind), meetCode, recipient: recipientEmail, kind, draftId, createdAt: new Date().toISOString(), subject });

        // kim-inbox へ積む
        try {
          const { addItem } = await import('./kim-inbox.mjs');
          await addItem(os.homedir(), {
            kind: 'ask',
            source: 'meeting-url-notice',
            text: `【会議URL案内の送信確認】\n宛先: ${recipientEmail}\n件名: ${subject}\n\n${body}\n\n送信コマンド:\nnode tools/gmail-draft.mjs --send ${draftId}`,
            dedupeKey: `meeting-url-notice:${meetCode}:${kind}`,
          });
        } catch { /* inbox 積みエラーでも継続 */ }

        return { judgment: 'draft_created', kind, draftId, subject };
      }
      if (mode === 'auto') {
        if (!config.autoSendApproved) {
          return { judgment: 'auto_denied', reason: 'autoSendApproved が false です' };
        }
        const { createDraft, sendDraft } = await import('./gmail-draft.mjs');
        let draftId = existingDraftId;
        if (!draftId) {
          const raw = buildRawMessage({ from, to: recipientEmail, subject, body });
          const draft = await createDraft({ user: from, raw });
          draftId = draft.id;
        }
        const sent = await sendDraft({ user: from, id: draftId });
        ledger.push({ key: buildLedgerKey(meetCode, recipientEmail, kind), meetCode, recipient: recipientEmail, kind, sentMessageId: sent.sentMessageId, sentAt: new Date().toISOString(), subject });
        return { judgment: 'sent', kind, sentMessageId: sent.sentMessageId, subject };
      }
      return { judgment: 'auto_denied', reason: '無効なモード' };
    },

    getFirstSentAt: (meetCode, email, l) => {
      const e = l.find(e => e.key === buildLedgerKey(meetCode, email, 'firstNotice'));
      return e?.sentAt ? Date.parse(e.sentAt) : 0;
    },
  };
}

// ── CLI エントリポイント ──

async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--mode') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('missing option value');
      options.mode = argv[++i];
    } else if (argv[i] === '--dry-run') {
      options.dryRun = true;
    } else throw new Error(`unknown option: ${argv[i]}`);
  }
  const dryRun = options.dryRun || false;
  const mode = options.mode || 'approve';
  if (mode !== 'approve' && mode !== 'auto' && !dryRun) throw new Error('--mode は approve または auto');

  const config = readJson(path.join(ROOT, 'config/meeting-url-notice.json'));
  const home = process.env.ORGIAST_HOME || os.homedir();
  const dir = path.join(home, '.claude/meeting-url-notice');
  const ledgerFile = path.join(dir, 'ledger.json');
  fs.mkdirSync(dir, { recursive: true });
  const ledger = readJson(ledgerFile, []);

  let release;
  if (!dryRun) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lockFile = path.join(dir, 'run.lock');
    try {
      fs.writeFileSync(lockFile, String(process.pid), { flag: 'wx', mode: 0o600 });
      release = () => { try { fs.unlinkSync(lockFile); } catch {} };
    } catch (e) {
      if (e.code === 'EEXIST') throw new Error('meeting-url-notice is already running');
      throw e;
    }
  }

  try {
    const events = await loadCalendarEvents(config);
    const deps = createProductionDeps({ mode, dryRun, config, ledger });
    const results = await processEvents({ events, config, ledger, deps });

    if (!dryRun) save(ledgerFile, ledger);

    const logFile = path.join(dir, 'log.jsonl');
    const logLine = JSON.stringify({ timestamp: new Date().toISOString(), mode, dryRun, resultCount: results.length, results }) + '\n';
    fs.appendFileSync(logFile, logLine, 'utf8');

    console.log(JSON.stringify({ results }, null, 2));
    return 0;
  } catch (e) {
    console.error(`meeting-url-notice: ${e.message}`);
    process.exitCode = 1;
    return 1;
  } finally {
    if (release) release();
  }
}

if (isEntry(import.meta.url)) main();
