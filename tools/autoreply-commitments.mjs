#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { getDriveToken } from './lib/drive-auth.mjs';
import { isEntry } from './is-entry.mjs';
import { addItem } from './kim-inbox.mjs';
import { routeCalendar, withCaseLabel } from './lib/calendar-shared.mjs';

const JST = 9 * 3600000;
const DAY = 24 * 3600000;
const meeting = /ミーティング|MTG|打ち?合わ?せ|面談|会議/i;
const call = /(?:お?電話|架電)(?:を)?(?:します|いたします|致します)/;
const proposalCall = /電話|架電|通話/;
const range = /(\d{1,2}):(\d{2})\s*[~〜～‐‑–—−-]\s*(\d{1,2}):(\d{2})/g;
const dayPattern = /明日|今日|同日|(?:(\d{4})[/-])?(\d{1,2})[月/](\d{1,2})日?|(\d{1,2})日(?!間|前|後)/g;

function visibleText(text) {
  return String(text ?? '').replace(/「[^」]*」|『[^』]*』|^\s*>.*$/gm, '').normalize('NFKC');
}

function resolveDay(match, now, previousDay) {
  const jst = new Date(new Date(now).getTime() + JST);
  if (!Number.isFinite(jst.getTime())) return null;
  if (['明日', '今日'].includes(match[0])) {
    return new Date(jst.getTime() + (match[0] === '明日' ? DAY : 0)).toISOString().slice(0, 10);
  }
  if (match[0] === '同日') return previousDay || null;
  const year = Number(match[1] || jst.getUTCFullYear());
  const month = Number(match[2] || jst.getUTCMonth() + 1);
  const day = Number(match[3] || match[4]);
  const value = new Date(Date.UTC(year, month - 1, day));
  if (value.getUTCMonth() + 1 !== month || value.getUTCDate() !== day) return null;
  return value.toISOString().slice(0, 10);
}

function schedule(text, now, previousDay) {
  const dates = [...text.matchAll(dayPattern)];
  const times = [...text.matchAll(range)];
  const date = dates.length === 1 ? resolveDay(dates[0], now, previousDay) : null;
  if (!date || times.length !== 1) return date ? { date } : {};
  const [, h, m, eh, em] = times[0].map(Number);
  if (h > 23 || eh > 23 || m > 59 || em > 59 || h * 60 + m >= eh * 60 + em) return { date };
  const stamp = (hour, minute) => `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`;
  return { date, start: stamp(h, m), end: stamp(eh, em) };
}

export function extractCommitments(text, { now = Date.now(), previousDay } = {}) {
  const commitments = [];
  // Keep ellipses as sentence boundaries even after NFKC.
  for (const part of visibleText(text).replace(/\.{2,}/g, '。').split(/(?<=[。!?！？])|\n/)) {
    const sentence = part.trim();
    if (!sentence || /[?？]|ません|しない|できない|(?:でしょうか|ですか|ますか)[。!！]?$/.test(sentence)) continue;
    const slot = schedule(sentence, now, previousDay);
    const isMeeting = meeting.test(sentence) && /設定|入れ|行い|調整|開催|実施|変更/.test(sentence)
      && /(?:します|いたします|致します|入れます|行います)/.test(sentence);
    const reschedules = /(?:変更|再設定)(?:します|いたします|致します)/.test(sentence) && [...sentence.matchAll(range)].length > 0;
    if (isMeeting || reschedules) commitments.push({ kind: 'meeting', sentence, ...slot });
    if (call.test(sentence)) commitments.push({ kind: 'call', sentence, ...slot });
    if (/(?:送ります|送り(?:します|いたします)|(?:送付|共有|送信)(?:します|いたします|致します))/.test(sentence)) {
      commitments.push({ kind: 'send', sentence, ...slot });
    }
    if (/(?:運用化|設定|登録|送信|送付|共有|実施|配置|完了|発行|変更|対応|確保)(?:しました|いたしました|致しました)|送りました/.test(sentence)) {
      commitments.push({ kind: 'done-claim', sentence });
    }
  }
  return commitments;
}

export function hasUnsupportedDoneClaim(answer) {
  return extractCommitments(answer).some(({ kind, sentence }) => kind === 'done-claim'
    && !/(?:https:\/\/[^\s<>「」【】、。]+|\beventId\s*[:=]\s*[a-z0-9_-]{5,})/i.test(sentence));
}

// Use the actual incoming message, never the model's assertion of consent.
export function commitmentContext(message, now) {
  const text = visibleText(message);
  const slot = schedule(text, now);
  if (!slot.start || /[?？]|難しい|無理|不可|都合が悪|現場|候補|かもしれ|でしょうか|ですか|ますか/.test(text)
    || !/(?:でお願いします|で大丈夫|で問題ありません|で承知|で確定|で可能|が空いています|でいけます)/.test(text)) return {};
  const kind = meeting.test(text) ? 'meeting' : proposalCall.test(text) ? 'call' : null;
  return { ...slot, kind };
}

const logPath = home => path.join(home, '.claude', 'discord-autoreply', 'commitments.jsonl');
function readLatest(home) {
  let raw;
  try { raw = fs.readFileSync(logPath(home), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  const rows = new Map();
  for (const line of raw.split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    rows.set(row.id, row);
  }
  return rows;
}
function append(home, row) {
  fs.mkdirSync(path.dirname(logPath(home)), { recursive: true });
  fs.appendFileSync(logPath(home), JSON.stringify(row) + '\n', { mode: 0o600 });
}
async function report(home, row, post, suffix = '') {
  await post(home, {
    kind: 'info', source: 'autoreply-commitments',
    text: `代理返答で約束したが未実行: ${row.sentence}\n${row.channelName} / replyId ${row.replyId}\n${row.reason}`,
    dedupeKey: `autoreply-commitment:${row.id}${suffix}`
  }, { localOnly: true, drain: false });
}

export async function registerCommitment(row, { getToken = getDriveToken, fetchImpl = globalThis.fetch, wait = sleep } = {}) {
  const token = await getToken({ impersonate: 'kim@orgiast.jp', scope: 'https://www.googleapis.com/auth/calendar.events', signal: AbortSignal.timeout(10000), fetchImpl });
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const withMeet = row.kind === 'meeting';
  const reminders = { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] };
  const labeled = withCaseLabel({
    summary: `【調整可】${withMeet ? `${row.channelName}との打ち合わせ` : `${row.senderName}さんに電話`}`,
    description: `登録元: autoreply-commitments\n出典: ${row.channelName}`,
  }, row.channelName, 'autoreply-commitments');
  const body = {
    id: row.id,
    ...labeled,
    start: { dateTime: row.start }, end: { dateTime: row.end }, reminders,
    ...(withMeet ? { conferenceData: { createRequest: { requestId: row.id, conferenceSolutionKey: { type: 'hangoutsMeet' } } } } : {}),
  };
  const calendarId = routeCalendar(body, { origin: 'ai' });
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const inserted = await fetchImpl(`${base}?sendUpdates=none&conferenceDataVersion=1`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
  });
  if (!inserted.ok && inserted.status !== 409) throw new Error(`Calendar insert HTTP ${inserted.status}`);
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await wait(1000 * attempt);
    const res = await fetchImpl(`${base}/${row.id}`, { headers, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`Calendar get HTTP ${res.status}`);
    const event = await res.json();
    if (event.id !== row.id || event.status === 'cancelled'
      || Date.parse(event.start?.dateTime) !== Date.parse(row.start)
      || Date.parse(event.end?.dateTime) !== Date.parse(row.end)
      || event.reminders?.useDefault !== false
      || !event.reminders.overrides?.some(r => r.method === 'popup' && r.minutes === 30)) {
      throw new Error('Calendar read-back mismatch');
    }
    if (!withMeet || /^https:\/\/meet\.google\.com\/[a-z0-9-]+$/i.test(event.hangoutLink || '')) {
      return { eventId: event.id, meetUrl: withMeet ? event.hangoutLink : null };
    }
  }
  throw new Error('Calendar Meet read-back failed');
}

export async function trackCommitments(home, entry, { addItemImpl = addItem, register = registerCommitment } = {}) {
  const now = Date.parse(entry.ts);
  const approval = commitmentContext(entry.approvalMessage, entry.approvalTs ?? now);
  const commitments = extractCommitments(entry.content, { now, previousDay: approval.date ?? entry.previousDay })
    .filter(({ kind }) => kind !== 'done-claim');
  if (!commitments.length || !entry.replyId) return;
  const latest = readLatest(home);
  for (const [index, item] of commitments.entries()) {
    const id = createHash('sha256').update(JSON.stringify([entry.where, entry.channelId, entry.replyId, index])).digest('hex');
    if (latest.get(id)?.status === 'registered') continue;
    const scheduled = item.kind === 'meeting' || item.kind === 'call';
    const unambiguous = approval.kind === item.kind || (approval.kind === null
      && commitments.filter(other => other.kind === 'meeting' || other.kind === 'call').length === 1);
    const consent = scheduled && unambiguous && item.start === approval.start && item.end === approval.end
      && Date.parse(item.start) > now;
    const row = {
      id, ts: entry.ts, channelName: entry.channelName, senderName: entry.senderName, replyId: entry.replyId,
      ...item, start: item.start ?? null, end: item.end ?? null, status: 'unexecuted',
      reason: item.kind === 'send' ? '送付の実行待ち' : consent ? 'カレンダー登録の確認待ち' : '日時または相手の了承を確認できません'
    };
    if (!latest.has(id)) append(home, row);
    if (consent) {
      try {
        const result = await register(row);
        append(home, { ...row, ...result, status: 'registered', reason: null });
        continue;
      } catch (error) {
        // Provider/network errors may carry credentials or private request details.
        row.reason = /^Calendar (?:insert HTTP \d{3}|get HTTP \d{3}|read-back mismatch|Meet read-back failed)$/.test(error.message)
          ? error.message : error.message === 'GWS proxy: unsupported scope'
            ? 'カレンダー書き込みに使える DWD 鍵がありません' : 'カレンダー認証または通信に失敗';
        append(home, row);
      }
    }
    await report(home, row, addItemImpl);
  }
}

export async function auditCommitments({ home = process.env.ORGIAST_HOME || os.homedir(), now = Date.now(), post = addItem } = {}) {
  let count = 0;
  for (const row of readLatest(home).values()) {
    if (row.status !== 'unexecuted' || !(now - Date.parse(row.ts) > DAY)) continue;
    await report(home, row, post, `:audit:${new Date(now + JST).toISOString().slice(0, 10)}`);
    count++;
  }
  return count;
}

if (isEntry(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--audit') {
    console.error('Usage: node tools/autoreply-commitments.mjs --audit');
    process.exitCode = 2;
  } else {
    try { console.log(`commitments audit: ${await auditCommitments()} 件`); }
    catch { console.error('commitments audit: 読み取りまたは kim-inbox 登録に失敗'); process.exitCode = 1; }
  }
}
