#!/usr/bin/env node
/**
 * meet-cue-scheduler.mjs — Meet カンペ 全自動スケジューラー
 * カレンダーを巡回し、社外参加者のいる Meet に自動準備 & 自動参加する
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

import { isEntry } from './is-entry.mjs';
import { askJev } from './jev.mjs';
import { getDriveToken, driveApi, DRIVE_SCOPE } from './lib/drive-auth.mjs';
import { setupCueDocument } from './lib/meet-cue-doc.mjs';
import { DEFAULT_SEAT_HOSTNAMES, matchesSeatHostname, resolveBotDisplayName, resolveSeatHostnames } from './lib/meet-cue-core.mjs';
import { generateCardsFromBrief, generateSessionId } from './meet-cue.mjs';
import { matchMeetingInquiries, INQUIRY_SHEET, INQUIRY_TAB, readSheet } from './lib/inquiry-sheet.mjs';
import { addItem } from './kim-inbox.mjs';
import { sendDiscordDm } from './discord-dm.mjs';
import { calendarStartMs, isInternalEmail } from './lib/calendar-shared.mjs';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const ADMIN_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';

export const JOIN_WINDOW_BEFORE_MS = 5 * 60 * 1000; // 開始5分前
export const JOIN_WINDOW_AFTER_MS = 15 * 60 * 1000; // 開始後15分
export const JOIN_ERROR_COOLDOWN_MS = 10 * 60 * 1000; // 10分間再試行抑制

export const homeDir = () => process.env.ORGIAST_HOME || os.homedir();
export const meetCueBaseDir = (home = homeDir()) => path.join(home, '.claude', 'meet-cue');
export const schedulerStatePath = (home = homeDir()) => path.join(meetCueBaseDir(home), 'scheduler-state.json');
export const botLoginPath = (home = homeDir()) => path.join(meetCueBaseDir(home), 'bot-login.json');

export function readConfig(home = homeDir()) {
  const configPath = path.join(__dirname, '..', 'config', 'meet-cue.json');
  try {
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      return {
        enabled: parsed.enabled ?? true,
        seatHostnames: resolveSeatHostnames(parsed.seatHostnames == null && !parsed.seatHostname
          ? { seatHostnames: DEFAULT_SEAT_HOSTNAMES } : parsed),
        calendars: Array.isArray(parsed.calendars) && parsed.calendars.length > 0
          ? parsed.calendars
          : ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'],
        maxConcurrent: parsed.maxConcurrent || 3,
        botDisplayName: resolveBotDisplayName(parsed),
      };
    }
  } catch (e) {
    console.error('meet-cue-scheduler: config/meet-cue.json 読み込み失敗:', e.message);
  }
  return {
    enabled: true,
    seatHostnames: DEFAULT_SEAT_HOSTNAMES,
    calendars: ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'],
    maxConcurrent: 3,
    botDisplayName: resolveBotDisplayName({}),
  };
}

export function loadStaffAddresses(home = homeDir()) {
  const staffPath = path.join(__dirname, '..', 'config', 'staff-addresses.json');
  try {
    if (fs.existsSync(staffPath)) {
      const data = JSON.parse(fs.readFileSync(staffPath, 'utf8'));
      if (Array.isArray(data.addresses)) {
        return data.addresses.map(a => String(a).toLowerCase());
      }
    }
  } catch (e) {
    console.error('meet-cue-scheduler: staff-addresses.json 読み込み失敗:', e.message);
  }
  return [];
}

export function loadSchedulerState(home = homeDir()) {
  const p = schedulerStatePath(home);
  try {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch { /* ignore */ }
  return {};
}

export function saveSchedulerState(state, home = homeDir()) {
  const p = schedulerStatePath(home);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const temporary = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(temporary, p);
}

export function isExternalEmail(email, staffAddresses = []) {
  if (!email || typeof email !== 'string') return false;
  const lower = email.toLowerCase().trim();
  if (lower.endsWith('@orgiast.jp')) return false;
  if (staffAddresses.some(sa => sa === lower)) return false;
  return true;
}

export function extractMeetInfo(event) {
  const hangoutLink = event.hangoutLink || '';
  let meetUrl = hangoutLink;
  if (!meetUrl && event.conferenceData?.entryPoints) {
    const videoEntry = event.conferenceData.entryPoints.find(e => e.entryPointType === 'video');
    if (videoEntry?.uri) meetUrl = videoEntry.uri;
  }
  if (!meetUrl) return null;

  const match = meetUrl.match(/meet\.google\.com\/([a-z0-9-]+)/i);
  const conferenceCode = match ? match[1].toLowerCase() : (event.conferenceData?.conferenceId || null);
  if (!conferenceCode) return null;

  return { meetUrl, conferenceCode };
}

export function checkMechanicalConditions(event, { staffAddresses = [], ownerEmail = '', now = new Date(), hours = 24 } = {}) {
  if (!event || event.status === 'cancelled') return { ok: false, reason: 'cancelled' };

  const meetInfo = extractMeetInfo(event);
  if (!meetInfo) return { ok: false, reason: 'no_meet' };

  // Time window: start within past JOIN_WINDOW_AFTER_MS (15 min) to next N hours
  const startTime = new Date(event.start?.dateTime || event.start?.date || 0);
  const nowMs = now.getTime();
  const startMs = startTime.getTime();
  const minTime = nowMs - JOIN_WINDOW_AFTER_MS;
  const maxTime = nowMs + hours * 60 * 60 * 1000;

  if (startMs < minTime || startMs > maxTime) return { ok: false, reason: 'outside_window' };

  // Title / description exclude flags
  const titleDesc = `${event.summary || ''} ${event.description || ''}`;
  if (/カンペ不要|no[\-_]?kanpe/i.test(titleDesc)) return { ok: false, reason: 'opt_out' };

  // Private / confidential
  const visibility = event.visibility || 'default';
  if (visibility === 'private' || visibility === 'confidential') return { ok: false, reason: 'private' };

  const attendees = event.attendees || [];

  // Orgiast attendee check
  let hasOrgiast = attendees.some(a => a.email && a.email.toLowerCase().endsWith('@orgiast.jp'));
  if (!hasOrgiast && event.organizer?.email?.toLowerCase().endsWith('@orgiast.jp')) hasOrgiast = true;
  if (!hasOrgiast && ownerEmail && ownerEmail.toLowerCase().endsWith('@orgiast.jp')) hasOrgiast = true;

  if (!hasOrgiast) return { ok: false, reason: 'no_orgiast' };

  return { ok: true, reason: null };
}

export function isTargetEvent(event, options = {}) {
  return checkMechanicalConditions(event, options).ok;
}

export function buildClassificationJevState(event, staffAddresses = []) {
  const attendees = event.attendees || [];
  const externalAttendees = attendees.filter(a => !a.resource && a.email && isExternalEmail(a.email, staffAddresses));

  const externalAttendeeDomains = Array.from(new Set(
    externalAttendees.map(a => a.email.split('@')[1]?.toLowerCase()).filter(Boolean)
  ));

  const internalAttendees = attendees.filter(a => a.email && !isExternalEmail(a.email, staffAddresses));
  const internalCount = internalAttendees.length;

  const organizerEmail = event.organizer?.email || '';
  const organizerIsInternal = !isExternalEmail(organizerEmail, staffAddresses);

  const cleanDescription = (event.description || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);

  return {
    title: event.summary || '',
    description: cleanDescription,
    externalAttendeeDomains,
    externalDomains: externalAttendeeDomains,
    hasExternalAttendees: externalAttendees.length > 0,
    internalCount,
    organizerIsInternal,
  };
}

export function buildClassificationJevQuestions() {
  return {
    kind: {
      type: 'choice',
      instructions: 'この予定が顧客・取引先との商談・打合せか分類してください。招待者に社外の人がいなくても、題名に会社名・「様」・訪問・ご説明・商談などがあれば customer_meeting の可能性が高い。社員の名前だけ・定例・作業日・社内MTG は internal。',
      criteria: {
        customer_meeting: 'お客様・見込み客・取引先・協業先・仕入先との商談や打合せ。営業・提案・ヒアリング・見積・進行確認を含む',
        internal: '社内会議・社員同士・個人Gmailの社員',
        community: '勉強会・セミナー・コミュニティ・瞑想会・交流会',
        personal: '私用・面接の受け手でない個人予定など',
        other: 'その他',
      },
    },
  };
}

export function isOptInEvent(event) {
  const title = event.summary || '';
  const titleDesc = `${title} ${event.description || ''}`;
  return /カンペ/i.test(title) && !/カンペ不要|no[\-_]?kanpe/i.test(titleDesc);
}

export function createEventContentHash(event) {
  const meetInfo = extractMeetInfo(event);
  const conferenceCode = meetInfo?.conferenceCode || '';
  const startTime = event.start?.dateTime || event.start?.date || '';
  const title = event.summary || '';
  const description = event.description || '';
  const str = `${conferenceCode}|${startTime}|${title}|${description}`;
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 16);
}

export async function classifyEvent(event, { itemState = {}, staffAddresses = [], home = homeDir(), askJevImpl = askJev } = {}) {
  // 1. Explicit opt-in check
  if (isOptInEvent(event)) {
    return {
      classification: { kind: 'customer_meeting', confidence: 1.0, source: 'optin' },
      isTarget: true,
      reason: null,
    };
  }

  // 2. Hash check for state cache
  const contentHash = createEventContentHash(event);
  if (itemState.classificationCache && itemState.classificationCache.hash === contentHash) {
    const { kind, confidence } = itemState.classificationCache;
    const isTarget = kind === 'customer_meeting' && confidence >= 0.7;
    const reason = isTarget ? null : (kind === 'customer_meeting' ? 'jev:low_confidence' : `jev:${kind}`);
    return {
      classification: { kind, confidence, source: 'cache' },
      isTarget,
      reason,
    };
  }

  // 3. Retry count check (max 3 retries)
  const retries = itemState.classifyRetry || 0;
  if (retries >= 3) {
    return {
      classification: null,
      isTarget: false,
      reason: 'jev:failed',
    };
  }

  // 4. Call Jev
  const jevState = buildClassificationJevState(event, staffAddresses);
  const questions = buildClassificationJevQuestions();

  try {
    const result = await askJevImpl({
      state: jevState,
      questions,
      label: 'meet-cue-scheduler-classify',
      home,
    });

    if (result?.ok && result.answers?.kind?.choice) {
      const choiceAns = result.answers.kind;
      const kind = choiceAns.choice;
      const confidence = typeof choiceAns.confidence === 'number' ? choiceAns.confidence : 1.0;

      // Update state cache
      itemState.classificationCache = {
        hash: contentHash,
        kind,
        confidence,
        at: new Date().toISOString(),
      };
      itemState.classifyRetry = 0;

      const isTarget = kind === 'customer_meeting' && confidence >= 0.7;
      const reason = isTarget ? null : (kind === 'customer_meeting' ? 'jev:low_confidence' : `jev:${kind}`);
      return {
        classification: { kind, confidence, source: 'jev' },
        isTarget,
        reason,
      };
    }
  } catch {
    /* ignore and record retry */
  }

  // Jev failed or returned invalid response
  itemState.classifyRetry = retries + 1;
  return {
    classification: null,
    isTarget: false,
    reason: 'jev:failed',
  };
}

export function deduplicateEvents(events) {
  const seen = new Map();
  const result = [];

  for (const item of events) {
    const meetInfo = extractMeetInfo(item.event);
    if (!meetInfo) continue;

    const startStr = item.event.start?.dateTime || item.event.start?.date || '';
    const key = `${meetInfo.conferenceCode}_${startStr}`;

    if (!seen.has(key)) {
      seen.set(key, true);
      result.push(item);
    }
  }

  return result;
}

export async function fetchTargetCalendars({ getToken = getDriveToken, fetchImpl = globalThis.fetch, baseCalendars = [] } = {}) {
  const calendars = new Set(baseCalendars);

  try {
    const token = await getToken({ impersonate: 'kim@orgiast.jp', scope: ADMIN_SCOPE });
    const url = 'https://admin.googleapis.com/admin/directory/v1/users?customer=my_customer&maxResults=500';
    const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });

    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data.users)) {
        for (const user of data.users) {
          if (!user.suspended && user.primaryEmail && user.primaryEmail.toLowerCase().endsWith('@orgiast.jp')) {
            calendars.add(user.primaryEmail.toLowerCase());
          }
        }
      }
    } else {
      const errText = await res.text();
      console.log(`[meet-cue-scheduler] Admin Directory API skipped: ${res.status} ${errText.slice(0, 100)}`);
    }
  } catch (err) {
    console.log(`[meet-cue-scheduler] Admin Directory API skipped: ${err.message}`);
  }

  return Array.from(calendars);
}

export async function listCalendarEvents({ calendarId, token, now = new Date(), hours = 24, fetchImpl = globalThis.fetch }) {
  const timeMin = new Date(now.getTime() - JOIN_WINDOW_AFTER_MS).toISOString();
  const timeMax = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    maxResults: '250',
    showDeleted: 'false',
  });

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const items = [];
  let pageToken;
  do {
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetchImpl(`${url}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Calendar API list ${calendarId} HTTP ${res.status}`);
    const data = await res.json();
    items.push(...(data.items || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return items;
}

export function findSeisakuProfileName(userDataDir) {
  const localStatePath = path.join(userDataDir, 'Local State');
  try {
    if (fs.existsSync(localStatePath)) {
      const state = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
      const cache = state.profile?.info_cache;
      if (cache && typeof cache === 'object') {
        for (const [profName, info] of Object.entries(cache)) {
          if (info.user_name && info.user_name.toLowerCase() === 'seisaku-team@orgiast.jp') {
            return profName;
          }
        }
      }
    }
  } catch { /* ignore */ }
  return null;
}

export async function attemptAutoLogin({ home = homeDir(), fetchImpl = globalThis.fetch, execImpl = execFileAsync } = {}) {
  const loginFile = botLoginPath(home);
  if (fs.existsSync(loginFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(loginFile, 'utf8'));
      if (data.ok) return { ok: true, skipped: 'already_logged_in' };
    } catch { /* ignore */ }
  }

  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const userDataDir = path.join(localAppData, 'Google', 'Chrome', 'User Data');
  const profileName = findSeisakuProfileName(userDataDir);

  if (!profileName) {
    return { ok: false, reason: 'profile_not_found' };
  }

  const scriptPath = fileURLToPath(new URL('./meet-cue.mjs', import.meta.url));
  try {
    await execImpl(process.execPath, [
      scriptPath,
      'login',
      '--from-chrome-profile',
      profileName,
    ], { windowsHide: true, timeout: 60000 });
    return { ok: true, profileName };
  } catch (err) {
    if (err.code === 75 || (err.stdout && err.stdout.includes('chrome_running'))) {
      return { ok: false, reason: 'chrome_running' };
    }
    return { ok: false, reason: err.message };
  }
}

/**
 * 内部のみの予定（主催が orgiast.jp かつ参加者全員が社内）の説明欄にカンペ URL を追記する。
 * 既に同じ URL が説明欄にあれば追記しない。
 */
export async function appendCueUrlToDescription({ token, calendarId, event, docUrl, fetchImpl = globalThis.fetch }) {
  const existingDesc = event.description || '';
  const line = `📝カンペ: ${docUrl}`;
  if (existingDesc.split(/\r?\n/).some(entry => entry.trim() === line)) return { appended: false, reason: 'already_exists' };

  const patchBody = { description: [existingDesc, line].filter(Boolean).join('\n') };
  const patchUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(event.id)}?sendUpdates=none`;
  const res = await fetchImpl(patchUrl, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...(event.etag ? { 'If-Match': event.etag } : {}) },
    body: JSON.stringify(patchBody),
  });
  if (!res.ok) throw new Error(`Description append failed HTTP ${res.status}: ${await res.text()}`);
  return { appended: true };
}

export async function sendCueDocUrlAsDm({ staffEmail, docUrl, home = homeDir() }) {
  if (staffEmail === 'kim@orgiast.jp') {
    await addItem(home, {
      kind: 'info',
      text: `【Meetカンペ】カンペ Doc ができました: ${docUrl}`,
      source: 'meet-cue',
    });
    return;
  }
  const body = `【Meetカンペ】開始が近づきました。打合せ用カンペ Doc です: ${docUrl}\n\n打合せ中はこの Doc にカンペが表示されます。`;
  await sendDiscordDm(staffEmail, body, { home, noReplyFooter: true, noCopyKim: true });
}

async function shareCueDocument(itemState, recipients, getToken) {
  const pending = recipients.filter(email =>
    email !== 'seisaku-team@orgiast.jp' && email !== 'kim@orgiast.jp' && !itemState.cueDocReaders?.includes(email));
  if (!pending.length) return;

  const token = await getToken({ impersonate: 'seisaku-team@orgiast.jp', scope: DRIVE_SCOPE });
  const base = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(itemState.docId)}/permissions`;
  const params = new URLSearchParams({ supportsAllDrives: 'true', fields: 'nextPageToken,permissions(emailAddress)' });
  const existing = new Set();
  let pageToken;
  do {
    if (pageToken) params.set('pageToken', pageToken);
    const page = await (await driveApi(token, `${base}?${params}`)).json();
    for (const permission of page.permissions || []) existing.add(permission.emailAddress?.toLowerCase());
    pageToken = page.nextPageToken;
  } while (pageToken);

  for (const emailAddress of pending) {
    if (!existing.has(emailAddress)) {
      await driveApi(token, `${base}?supportsAllDrives=true&sendNotificationEmail=false`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'user', role: 'reader', emailAddress }),
      });
    }
    (itemState.cueDocReaders ??= []).push(emailAddress);
  }
}

export async function deliverCueUrl({
  event, itemState, now, getToken, fetchImpl, home,
  calendarId, sendCue = sendCueDocUrlAsDm, grantAccess = async () => {},
  checkpoint = () => {}, onError = () => {},
}) {
  if (!itemState.staffUrl) return;
  const docUrl = new URL(itemState.staffUrl);
  docUrl.searchParams.delete('authuser');
  const organizer = event.organizer?.email;
  const attendees = event.attendees || [];
  const targets = [...new Set([organizer, ...attendees.map(a => a.email)]
    .filter(isInternalEmail).map(email => email.trim().toLowerCase()))];
  if (isInternalEmail(organizer) && !event.attendeesOmitted && attendees.every(a => isInternalEmail(a.email))) {
    if (calendarId !== organizer.trim().toLowerCase()) throw new Error('主催者の予定を取得できませんでした');
    await grantAccess(targets);
    const token = await getToken({ impersonate: calendarId, scope: CALENDAR_SCOPE });
    await appendCueUrlToDescription({ token, calendarId, event, docUrl: docUrl.href, fetchImpl });
    itemState.cueUrlAppended = true;
    return;
  }

  const start = calendarStartMs(event);
  itemState.cueDmDueAt = new Date(start - 10 * 60000).toISOString();
  itemState.cueDmTargets = targets;
  if (now.getTime() < start - 10 * 60000 || now.getTime() >= start) return;
  const sent = itemState.cueDmDelivered ??= {};
  for (const staffEmail of targets) {
    if (sent[staffEmail]) continue;
    try {
      await grantAccess([staffEmail]);
      docUrl.searchParams.set('authuser', staffEmail);
      await sendCue({ staffEmail, docUrl: docUrl.href, home });
    } catch (error) {
      onError(staffEmail, error);
      continue;
    }
    sent[staffEmail] = now.toISOString();
    checkpoint();
  }
  itemState.cueDmSent = targets.length > 0 && targets.every(email => sent[email]);
}

export function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function runScheduler(options = {}) {
  const home = options.home || homeDir();
  const now = options.now ? new Date(options.now) : new Date();
  const hours = options.hours ? parseInt(options.hours, 10) : 24;
  const dryRun = Boolean(options.dryRun || options['dry-run']);
  const getToken = options.getToken || getDriveToken;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const sheetReader = options.readSheet || readSheet;
  const askJevImpl = options.askJevImpl || askJev;

  const config = options.config || readConfig(home);
  const staffAddresses = loadStaffAddresses(home);
  const state = options.state || loadSchedulerState(home);

  // Seat hostname check
  const currentHostname = options.hostname || options.deps?.hostname || os.hostname();
  const seatHostnames = resolveSeatHostnames(config);
  if (!matchesSeatHostname(seatHostnames, currentHostname)) {
    console.log(`[meet-cue-scheduler] seatHostname 不一致のため待機 (現在: ${currentHostname}, 対象: ${seatHostnames.join(', ')})`);
    return {
      ok: true,
      skippedHost: true,
      skipped: 'seat_hostname_mismatch',
      actions: [],
      skippedEvents: [],
      currentHostname,
      targetHostname: seatHostnames.join(', '),
    };
  }

  if (config.enabled === false) {
    console.log('[meet-cue-scheduler] config.enabled が false のため終了');
    return { ok: true, skipped: 'disabled', actions: [], skippedEvents: [] };
  }

  // Try auto login if needed
  if (!dryRun) {
    await attemptAutoLogin({ home, fetchImpl });
  }

  // Fetch target calendars
  const targetCalendars = await fetchTargetCalendars({ getToken, fetchImpl, baseCalendars: config.calendars });
  console.log(`[meet-cue-scheduler] 巡回対象カレンダー (${targetCalendars.length}件):`, targetCalendars.join(', '));

  // Collect events across target calendars
  const errors = [];
  const uniqueCalendarEvents = new Map();

  for (const calId of targetCalendars) {
    try {
      const token = await getToken({ impersonate: calId, scope: CALENDAR_SCOPE });
      const events = await listCalendarEvents({ calendarId: calId, token, now, hours, fetchImpl });
      for (const ev of events) {
        const meetInfo = extractMeetInfo(ev);
        const startStr = ev.start?.dateTime || ev.start?.date || '';
        const key = meetInfo ? `${meetInfo.conferenceCode}_${startStr}` : `${ev.id}_${startStr}`;
        if (!uniqueCalendarEvents.has(key) || ev.organizer?.self) {
          uniqueCalendarEvents.set(key, { event: ev, calendarId: calId });
        }
      }
    } catch (err) {
      console.error(`[meet-cue-scheduler] カレンダー取得エラー (${calId}):`, err.message);
      errors.push({ calendarId: calId, error: err.message });
    }
  }

  const targetEvents = [];
  const skippedEvents = [];

  for (const { event, calendarId } of uniqueCalendarEvents.values()) {
    const startIso = new Date(event.start?.dateTime || event.start?.date || 0).toISOString();

    // 1. Mechanical check
    const mech = checkMechanicalConditions(event, { staffAddresses, ownerEmail: calendarId, now, hours });
    if (!mech.ok) {
      if (mech.reason !== 'outside_window' && mech.reason !== 'cancelled') {
        skippedEvents.push({
          title: event.summary || '',
          startTime: startIso,
          reason: mech.reason,
        });
      }
      continue;
    }

    const meetInfo = extractMeetInfo(event);
    const eventKey = `${meetInfo.conferenceCode}_${startIso}`;
    const itemState = state[eventKey] || {};

    // 2. Jev / Opt-in / Cache classification
    const classRes = await classifyEvent(event, {
      itemState,
      staffAddresses,
      home,
      askJevImpl,
    });

    state[eventKey] = itemState;

    if (classRes.isTarget) {
      targetEvents.push({
        event,
        calendarId,
        classification: classRes.classification,
      });
    } else {
      skippedEvents.push({
        title: event.summary || '',
        startTime: startIso,
        reason: classRes.reason,
      });
    }
  }

  console.log(`[meet-cue-scheduler] 対象 Meet 予定: ${targetEvents.length}件 (スキップ: ${skippedEvents.length}件)`);

  // Load inquiry sheet data once if available
  let sheetValues = [];
  try {
    sheetValues = await sheetReader(INQUIRY_SHEET, INQUIRY_TAB, { getToken, fetchImpl });
  } catch (err) {
    console.error('[meet-cue-scheduler] 問い合わせ台帳読み込み警告:', err.message);
  }

  const plannedActions = [];

  for (const { event, calendarId, classification } of targetEvents) {
    const meetInfo = extractMeetInfo(event);
    if (!meetInfo) continue;

    const startTime = new Date(event.start?.dateTime || event.start?.date);
    const startMs = startTime.getTime();
    const durationMinutes = Math.max(30, Math.round(((new Date(event.end?.dateTime || event.end?.date)).getTime() - startMs) / 60000));
    const startIso = startTime.toISOString();
    const eventKey = `${meetInfo.conferenceCode}_${startIso}`;

    const itemState = state[eventKey] || {};

    // 1a. Preparation
    const attendees = event.attendees || [];
    const orgiastAttendees = attendees
      .map(a => a.email ? a.email.toLowerCase() : '')
      .filter(e => e.endsWith('@orgiast.jp'));

    if (!orgiastAttendees.includes(calendarId.toLowerCase()) && calendarId.toLowerCase().endsWith('@orgiast.jp')) {
      orgiastAttendees.push(calendarId.toLowerCase());
    }

    // Determine staff email for cue doc
    let staffEmail = orgiastAttendees.find(e => e !== 'kim@orgiast.jp' && e !== 'seisaku-team@orgiast.jp');
    if (!staffEmail) staffEmail = orgiastAttendees[0] || 'seisaku-team@orgiast.jp';

    let docId = itemState.docId;

    if ((!docId || !itemState.cardsFile) && !dryRun) {
      try {
        console.log(`[meet-cue-scheduler] カンペ Doc 作成開始: "${event.summary}" (${staffEmail})`);
        const docInfo = docId ? { docId, staffUrl: itemState.staffUrl } : await setupCueDocument({
          title: event.summary || '打合せ',
          staff: staffEmail,
          impersonate: 'seisaku-team@orgiast.jp',
          getToken,
        });

        docId = docInfo.docId;
        itemState.docId = docId;
        itemState.staffUrl = docInfo.staffUrl;

        // Build brief
        const cleanDesc = (event.description || '').replace(/<[^>]+>/g, ' ').slice(0, 2000);
        const externalDomains = Array.from(new Set(
          attendees
            .filter(a => a.email && isExternalEmail(a.email, staffAddresses))
            .map(a => a.email.split('@')[1])
        ));

        let inquiryText = '';
        try {
          const matchedInquiries = matchMeetingInquiries(sheetValues, { event });
          if (matchedInquiries.length > 0) {
            inquiryText = '\n【関連問い合わせ台帳】\n' + matchedInquiries.map(r => {
              const row = r.row || r;
              return `- 社名: ${row[5] || '不明'} / 内容: ${row[12] || row[6] || ''} / 予算: ${row[13] || '未記載'} / 会場: ${row[14] || ''}`;
            }).join('\n');
          }
        } catch { /* ignore inquiry match errors */ }

        const brief = `予定名: ${event.summary || '打合せ'}\n参加ドメイン: ${externalDomains.join(', ')}\n説明:\n${cleanDesc}${inquiryText}`;
        const prepDir = path.join(meetCueBaseDir(home), 'prep', `${meetInfo.conferenceCode}-${startMs}`);
        fs.mkdirSync(prepDir, { recursive: true });

        fs.writeFileSync(path.join(prepDir, 'brief.txt'), brief, 'utf8');

        // Generate cards
        const cards = await generateCardsFromBrief(brief, home);
        fs.writeFileSync(path.join(prepDir, 'cards.json'), JSON.stringify(cards, null, 2), 'utf8');

        itemState.cardsFile = path.join(prepDir, 'cards.json');
        itemState.briefFile = path.join(prepDir, 'brief.txt');

        itemState.prepared = true;
      } catch (err) {
        console.error(`[meet-cue-scheduler] 準備失敗 (${event.summary}):`, err.message);
        errors.push({ event: event.summary, stage: 'prep', error: err.message });
      }
    }

    if (!dryRun && itemState.prepared) {
      try {
        await deliverCueUrl({
          event, itemState, now, getToken, fetchImpl, home, calendarId,
          grantAccess: recipients => shareCueDocument(itemState, recipients, getToken),
          checkpoint: () => saveSchedulerState(state, home),
          onError: (target, error) => errors.push({ event: event.summary, stage: 'cueDm', target, error: error.message }),
        });
      } catch (error) {
        errors.push({ event: event.summary, stage: 'cueDelivery', error: error.message });
      }
    }

    // 1b. Join Meet Window check: start - 5 min to start + 15 min
    const nowMs = now.getTime();
    const windowStart = startMs - JOIN_WINDOW_BEFORE_MS;
    const windowEnd = startMs + JOIN_WINDOW_AFTER_MS;
    const inJoinWindow = nowMs >= windowStart && nowMs <= windowEnd;

    let actionStatus = 'idle';

    if (inJoinWindow) {
      const pidAlive = isPidAlive(itemState.joinedPid);
      if (pidAlive) {
        actionStatus = 'running';
      } else {
        // Check if previous attempt ended with joinError within 10 min
        if (itemState.sessionId && (!itemState.joinError || !itemState.lastJoinErrorTime)) {
          const sFile = path.join(meetCueBaseDir(home), itemState.sessionId, 'session.json');
          if (fs.existsSync(sFile)) {
            try {
              const sData = JSON.parse(fs.readFileSync(sFile, 'utf8'));
              if (sData.joinError) {
                itemState.joinError = sData.joinError;
                const st = fs.statSync(sFile);
                itemState.lastJoinErrorTime = st.mtimeMs;
              }
            } catch { /* ignore */ }
          }
        }

        const isRecentJoinError = itemState.joinError &&
          itemState.lastJoinErrorTime &&
          (nowMs - itemState.lastJoinErrorTime < JOIN_ERROR_COOLDOWN_MS);

        if (isRecentJoinError) {
          actionStatus = 'join_error_cooldown';
          console.log(`[meet-cue-scheduler] joinError (${itemState.joinError}) 発生後 10 分以内のため再試行スキップ: ${event.summary}`);
        } else if (!dryRun && docId && itemState.cardsFile) {
          // Count active concurrent running sessions
          const activeCount = Object.values(state).filter(s => isPidAlive(s.joinedPid)).length;
          if (activeCount >= config.maxConcurrent) {
            actionStatus = 'max_concurrent_exceeded';
            console.log(`[meet-cue-scheduler] 同時上限(${config.maxConcurrent})超過のため参加保留: ${event.summary}`);
            try {
              await addItem(home, {
                kind: 'info',
                text: `【Meetカンペ待機】同時上限(${config.maxConcurrent})超過のため参加保留: ${event.summary}`,
                source: 'meet-cue-scheduler',
              });
            } catch { /* ignore */ }
          } else {
            // Launch meet-cue.mjs start in background detached
            try {
              const scriptPath = fileURLToPath(new URL('./meet-cue.mjs', import.meta.url));
              const sessionId = generateSessionId();
              const sessionDir = path.join(meetCueBaseDir(home), sessionId);
              fs.mkdirSync(meetCueBaseDir(home), { recursive: true });
              fs.mkdirSync(sessionDir, { mode: 0o700 });
              const args = [
                scriptPath,
                'start',
                '--session-id', sessionId,
                '--url', meetInfo.meetUrl,
                '--staff', staffEmail,
                '--title', event.summary || '打合せ',
                '--cards-file', itemState.cardsFile,
                '--doc-id', docId,
                ...(itemState.briefFile ? ['--brief-file', itemState.briefFile] : []),
                '--max-minutes', String(durationMinutes + 30),
              ];

              const logFd = fs.openSync(path.join(sessionDir, 'bot.log'), 'a', 0o600);
              let child;
              try {
                child = spawn(process.execPath, args, {
                  detached: true, windowsHide: true, stdio: ['ignore', logFd, logFd],
                  env: { ...process.env, ORGIAST_HOME: home },
                });
                await new Promise((resolve, reject) => {
                  child.once('spawn', resolve);
                  child.once('error', reject);
                });
              } finally {
                fs.closeSync(logFd);
              }
              child.unref();

              itemState.sessionId = sessionId;
              delete itemState.joinError;
              delete itemState.lastJoinErrorTime;
              itemState.joinedPid = child.pid;
              actionStatus = `launched_pid_${child.pid}`;
              console.log(`[meet-cue-scheduler] Meet Bot 起動成功 (PID: ${child.pid}, ${event.summary})`);
            } catch (err) {
              console.error(`[meet-cue-scheduler] Meet Bot 起動失敗 (${event.summary}):`, err.message);
              errors.push({ event: event.summary, stage: 'launch', error: err.message });
            }
          }
        }
      }
    }

    state[eventKey] = itemState;

    plannedActions.push({
      eventKey,
      title: event.summary,
      startTime: startIso,
      meetUrl: meetInfo.meetUrl,
      staffEmail,
      prepared: Boolean(itemState.prepared || docId),
      docId: docId || null,
      cueUrlAppended: Boolean(itemState.cueUrlAppended),
      cueDmSent: Boolean(itemState.cueDmSent),
      inJoinWindow,
      actionStatus,
      classification,
    });
  }

  if (!dryRun) {
    saveSchedulerState(state, home);

    // Append log
    const logDir = path.join(home, '.claude', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    const logRecord = {
      at: now.toISOString(),
      targetCalendarsCount: targetCalendars.length,
      targetEventsCount: targetEvents.length,
      actions: plannedActions,
      skipped: skippedEvents,
      errors,
    };
    fs.appendFileSync(path.join(logDir, 'meet-cue-scheduler.jsonl'), JSON.stringify(logRecord) + '\n', 'utf8');
  }

  const hasErrors = errors.length > 0;
  return {
    ok: !hasErrors,
    dryRun,
    targetCalendars,
    targetEventsCount: targetEvents.length,
    actions: plannedActions,
    skipped: skippedEvents,
    errors,
  };
}

/**
 * 移行: meetCueSource が付いた「📝カンペ」予定のうち、今後開始するものを削除する。
 * 過去の予定は残す。削除結果を ~/.claude/logs/meet-cue-companion-cleanup.json に書き出す。
 */
export async function migrateCleanupCompanions({
  dryRun = false, getTokenImpl = getDriveToken, fetchImpl = globalThis.fetch,
  home = homeDir(), now = new Date(), calendars,
} = {}) {
  const targets = calendars || await fetchTargetCalendars({
    getToken: getTokenImpl, fetchImpl, baseCalendars: readConfig(home).calendars,
  });
  const candidates = [], deleted = [], errors = [];
  for (const calendarId of targets) {
    try {
      const token = await getTokenImpl({ impersonate: calendarId, scope: CALENDAR_SCOPE });
      const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
      const params = new URLSearchParams({ timeMin: now.toISOString(), maxResults: '2500', showDeleted: 'false' });
      const events = [];
      let pageToken;
      do {
        if (pageToken) params.set('pageToken', pageToken);
        const res = await fetchImpl(`${base}?${params}`, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Calendar list HTTP ${res.status}`);
        const page = await res.json();
        events.push(...(page.items || []));
        pageToken = page.nextPageToken;
      } while (pageToken);

      for (const event of events) {
        if (!event.summary?.startsWith('📝カンペ:') || !event.extendedProperties?.private?.meetCueSource ||
            !(calendarStartMs(event) > now.getTime())) continue;
        const { id, summary } = event;
        const item = { calendarId, id, summary };
        candidates.push(item);
        if (dryRun) continue;
        try {
          const res = await fetchImpl(`${base}/${encodeURIComponent(id)}?sendUpdates=none`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}`, ...(event.etag ? { 'If-Match': event.etag } : {}) },
          });
          if (!res.ok) throw new Error(`Calendar delete HTTP ${res.status}`);
          deleted.push(item);
        } catch (error) {
          errors.push({ ...item, error: error.message });
        }
      }
    } catch (error) {
      errors.push({ calendarId, error: error.message });
    }
  }

  const result = { ok: errors.length === 0, dryRun, candidates, deletedCount: deleted.length, deleted, errors };
  if (!dryRun) {
    const logDir = path.join(home, '.claude', 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'meet-cue-companion-cleanup.json'), JSON.stringify({ at: now.toISOString(), ...result }, null, 2));
  }
  return result;
}

export async function main(argv = process.argv.slice(2)) {
  if (argv.includes('--migrate-companions')) {
    const result = await migrateCleanupCompanions({ dryRun: argv.includes('--dry-run') });
    console.log(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }

  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      hours: { type: 'string' },
      now: { type: 'string' },
    },
  });

  try {
    const result = await runScheduler({
      dryRun: Boolean(values['dry-run']),
      hours: values.hours,
      now: values.now,
    });

    if (values['dry-run']) {
      console.log(JSON.stringify(result, null, 2));
    }

    const code = result.ok ? 0 : 1;
    if (isEntry(import.meta.url)) {
      process.exit(code);
    }
    return code;
  } catch (err) {
    console.error('meet-cue-scheduler 致命的エラー:', err);
    if (isEntry(import.meta.url)) {
      process.exit(1);
    }
    throw err;
  }
}

if (isEntry(import.meta.url)) {
  main();
}
