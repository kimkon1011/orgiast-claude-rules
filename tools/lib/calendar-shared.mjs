import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Calendar の書き込みと通知先には社内ドメインだけを使う。staffAddresses があればそれも社内扱い。 */
export function isInternalEmail(email, staffAddresses = loadStaffAddresses()) {
  if (typeof email !== 'string') return false;
  const lower = email.trim().toLowerCase();
  if (/^[^\s@]+@orgiast\.jp$/i.test(lower)) return true;
  if (Array.isArray(staffAddresses) && staffAddresses.some(sa => sa.toLowerCase() === lower)) return true;
  return false;
}

export function loadStaffAddresses() {
  const staffPath = path.join(__dirname, '..', '..', 'config', 'staff-addresses.json');
  try {
    if (fs.existsSync(staffPath)) {
      const data = JSON.parse(fs.readFileSync(staffPath, 'utf8'));
      if (Array.isArray(data.addresses)) {
        return data.addresses.map(a => String(a).toLowerCase());
      }
    }
  } catch { /* ignore */ }
  return [];
}

export function sanitizeAttendees(attendees, { log = console.warn, staffAddresses = loadStaffAddresses() } = {}) {
  if (!Array.isArray(attendees)) return [];
  const dropped = [];
  const kept = attendees.filter(attendee => {
    if (isInternalEmail(attendee?.email, staffAddresses)) return true;
    if (attendee?.email) dropped.push(attendee.email);
    return false;
  });
  if (dropped.length) log(`[calendar] 社外アドレスを attendees から除外: ${dropped.join(', ')}`);
  return kept.map(attendee => ({ ...attendee, email: attendee.email.trim().toLowerCase() }));
}

export function isAcademicGroup(group) {
  return typeof group === 'string' && /nxa|学会/iu.test(group);
}

export const GAKKAI_CALENDAR = 'seisaku-team@orgiast.jp';
export const AI_CALENDAR = 'orgiast.jp_qqukp0gg2l94o501uhugn0i63s@group.calendar.google.com';
export const PREPARATION_PREFIX = '📋 準備: ';

const MEETING_WORDS = /^(?:M[:：])|訪問|電話|面談|面接|中途面談|打ち?合わせ|ミーティング|MTG|会議/iu;
const MEETING_URL = /(?:meet\.google\.com|zoom\.us|teams\.microsoft\.com)/iu;

export function isKimMeeting(ev = {}) {
  const text = [ev.summary, ev.description, ev.location, ev.hangoutLink].filter(Boolean).join('\n');
  const hasOtherAttendee = Array.isArray(ev.attendees)
    && ev.attendees.some(a => a?.email && a.email.toLowerCase() !== 'kim@orgiast.jp' && !a.resource);
  return MEETING_WORDS.test(String(ev.summary || '')) || MEETING_URL.test(text) || Boolean(ev.hangoutLink) || hasOtherAttendee;
}

export function routeCalendar(ev = {}, { origin } = {}) {
  if (isKimMeeting(ev)) return 'primary';
  const text = [ev.summary, ev.description, ev.location].filter(Boolean).join('\n');
  const ai = /^(?:【期限】|【自動】|【仮】|【延長】)|DeadlineWatch|Codex|Claude|auto-progress|fleet-mail|担当[：:]\s*(?:Claude|Codex|夜間)/iu.test(text);
  const recruiting = /急募|時給|求人|応募|Indeed|アルバイト|バイト/iu.test(text);
  const academic = /学会|学術集会|協賛ナビ/iu.test(text);
  return origin === 'ai' || ai || recruiting || academic ? AI_CALENDAR : 'primary';
}

export function withCaseLabel({ summary = '', description = '' } = {}, caseName, source = '不明') {
  const name = String(caseName || '').trim();
  const label = name ? `【${name}】` : '【案件未特定】';
  const caseLine = name ? `案件: ${name}` : `案件: 未特定（登録元: ${source}）`;
  const nextSummary = String(summary).includes(label) ? String(summary) : `${label}${summary}`;
  const lines = String(description).split(/\r?\n/);
  const nextDescription = lines[0] === caseLine ? String(description) : [caseLine, description].filter(Boolean).join('\n');
  return { summary: nextSummary, description: nextDescription };
}

export function isAcademicEvent(summary) {
  const title = summary?.startsWith(PREPARATION_PREFIX) ? summary.slice(PREPARATION_PREFIX.length) : summary;
  return isAcademicGroup(title?.match(/^【自動】【([^】]+)】/)?.[1]);
}

function calendarTimeMs(time) {
  return Date.parse(time?.dateTime || (time?.date ? `${time.date}T00:00:00+09:00` : ''));
}

export function calendarStartMs(event) {
  return calendarTimeMs(event.start);
}

export function calendarEndMs(event) {
  return calendarTimeMs(event.end);
}
