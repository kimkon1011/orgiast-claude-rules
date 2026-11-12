#!/usr/bin/env node
/**
 * meet-cue-scheduler.mjs — Meet カンペ 全自動スケジューラー
 * カレンダーを巡回し、社外参加者のいる Meet に自動準備 & 自動参加する
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseArgs } from 'node:util';

import { isEntry } from './is-entry.mjs';
import { getDriveToken, DRIVE_SCOPE } from './lib/drive-auth.mjs';
import { setupCueDocument } from './lib/meet-cue-doc.mjs';
import { generateCardsFromBrief } from './meet-cue.mjs';
import { matchMeetingInquiries, INQUIRY_SHEET, INQUIRY_TAB, readSheet } from './lib/inquiry-sheet.mjs';
import { addItem } from './kim-inbox.mjs';

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const ADMIN_SCOPE = 'https://www.googleapis.com/auth/admin.directory.user.readonly';

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
        seatHostname: parsed.seatHostname || 'DESKTOP-2D0R4LI',
        calendars: Array.isArray(parsed.calendars) && parsed.calendars.length > 0
          ? parsed.calendars
          : ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'],
        maxConcurrent: parsed.maxConcurrent || 3,
      };
    }
  } catch (e) {
    console.error('meet-cue-scheduler: config/meet-cue.json 読み込み失敗:', e.message);
  }
  return {
    enabled: true,
    seatHostname: 'DESKTOP-2D0R4LI',
    calendars: ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'],
    maxConcurrent: 3,
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
  fs.writeFileSync(p, JSON.stringify(state, null, 2), 'utf8');
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

export function isTargetEvent(event, { staffAddresses = [], ownerEmail = '', now = new Date(), hours = 24 } = {}) {
  if (!event || event.status === 'cancelled') return false;

  const meetInfo = extractMeetInfo(event);
  if (!meetInfo) return false;

  // Time window: start within past 10 minutes to next N hours
  const startTime = new Date(event.start?.dateTime || event.start?.date || 0);
  const nowMs = now.getTime();
  const startMs = startTime.getTime();
  const minTime = nowMs - 10 * 60 * 1000;
  const maxTime = nowMs + hours * 60 * 60 * 1000;

  if (startMs < minTime || startMs > maxTime) return false;

  // Title / description exclude flags
  const titleDesc = `${event.summary || ''} ${event.description || ''}`;
  if (/カンペ不要|no[\-_]?kanpe/i.test(titleDesc)) return false;

  // Private / confidential
  const visibility = event.visibility || 'default';
  if (visibility === 'private' || visibility === 'confidential') return false;

  const attendees = event.attendees || [];
  const externalAttendees = attendees.filter(a => !a.resource && a.email && isExternalEmail(a.email, staffAddresses));
  if (externalAttendees.length === 0) return false;

  // Orgiast attendee check
  let hasOrgiast = attendees.some(a => a.email && a.email.toLowerCase().endsWith('@orgiast.jp'));
  if (!hasOrgiast && event.organizer?.email?.toLowerCase().endsWith('@orgiast.jp')) hasOrgiast = true;
  if (!hasOrgiast && ownerEmail && ownerEmail.toLowerCase().endsWith('@orgiast.jp')) hasOrgiast = true;

  if (!hasOrgiast) return false;

  return true;
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
  const timeMin = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  const timeMax = new Date(now.getTime() + hours * 60 * 60 * 1000).toISOString();
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    singleEvents: 'true',
    maxResults: '250',
    showDeleted: 'false',
  });

  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`Calendar API list ${calendarId} HTTP ${res.status}`);
  }

  const data = await res.json();
  return data.items || [];
}

export function buildCompanionEventBody({ originalEvent, docUrl, orgiastAttendees = [] }) {
  const cleanSummary = (originalEvent.summary || '打合せ').replace(/^📝カンペ:\s*/, '');
  const description = `Bot が開始1分前に参加し、言うことをこの Doc の一番上に出します。kim は Doc に直接書けば届きます\n\n${docUrl}`;

  const attendees = orgiastAttendees.map(email => ({ email }));

  return {
    summary: `📝カンペ: ${cleanSummary}`,
    description,
    start: originalEvent.start,
    end: originalEvent.end,
    attendees,
    visibility: 'private',
    transparency: 'transparent',
    reminders: {
      useDefault: false,
      overrides: [{ method: 'popup', minutes: 5 }],
    },
    extendedProperties: {
      private: {
        meetCueSource: originalEvent.id,
      },
    },
  };
}

export async function findCompanionEvent({ token, calendarId, originalEventId, fetchImpl = globalThis.fetch }) {
  const query = new URLSearchParams({
    privateExtendedProperty: `meetCueSource=${originalEventId}`,
  });
  const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${query}`;
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const data = await res.json();
  if (data.items && data.items.length > 0) {
    return data.items[0];
  }
  return null;
}

export async function createOrUpdateCompanionEvent({ token, calendarId, originalEvent, docUrl, orgiastAttendees, fetchImpl = globalThis.fetch }) {
  const existing = await findCompanionEvent({ token, calendarId, originalEventId: originalEvent.id, fetchImpl });
  const body = buildCompanionEventBody({ originalEvent, docUrl, orgiastAttendees });

  if (!existing) {
    const postUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?sendUpdates=none`;
    const createRes = await fetchImpl(postUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    if (!createRes.ok) {
      throw new Error(`Companion event create failed HTTP ${createRes.status}: ${await createRes.text()}`);
    }
    const created = await createRes.json();

    // GET read-back verification
    const getUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(created.id)}`;
    const readBack = await fetchImpl(getUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (readBack.ok) {
      return await readBack.json();
    }
    return created;
  }

  // Handle existing: check if time or cancellation state changed
  let needsPatch = false;
  const patchBody = {};

  if (originalEvent.status === 'cancelled') {
    if (!existing.summary.includes('（中止）')) {
      patchBody.summary = `${existing.summary}（中止）`;
      needsPatch = true;
    }
  } else {
    if (JSON.stringify(existing.start) !== JSON.stringify(originalEvent.start) ||
        JSON.stringify(existing.end) !== JSON.stringify(originalEvent.end)) {
      patchBody.start = originalEvent.start;
      patchBody.end = originalEvent.end;
      needsPatch = true;
    }
  }

  if (needsPatch) {
    const patchUrl = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(existing.id)}?sendUpdates=none`;
    const patchRes = await fetchImpl(patchUrl, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(patchBody),
    });
    if (patchRes.ok) {
      return await patchRes.json();
    }
  }

  return existing;
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

  const scriptPath = path.join(path.dirname(import.meta.url.replace('file://', '')), 'meet-cue.mjs');
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

  const config = readConfig(home);
  const staffAddresses = loadStaffAddresses(home);
  const state = loadSchedulerState(home);

  // Seat hostname check
  const currentHostname = os.hostname();
  if (config.seatHostname && config.seatHostname.toLowerCase() !== currentHostname.toLowerCase()) {
    console.log(`[meet-cue-scheduler] seatHostname 不一致のため待機 (現在: ${currentHostname}, 対象: ${config.seatHostname})`);
    return { ok: true, skipped: 'seat_hostname_mismatch', currentHostname, targetHostname: config.seatHostname };
  }

  if (config.enabled === false) {
    console.log('[meet-cue-scheduler] config.enabled が false のため終了');
    return { ok: true, skipped: 'disabled' };
  }

  // Try auto login if needed
  if (!dryRun) {
    await attemptAutoLogin({ home, fetchImpl });
  }

  // Fetch target calendars
  const targetCalendars = await fetchTargetCalendars({ getToken, fetchImpl, baseCalendars: config.calendars });
  console.log(`[meet-cue-scheduler] 巡回対象カレンダー (${targetCalendars.length}件):`, targetCalendars.join(', '));

  // Collect events across target calendars
  const rawTargetEvents = [];
  const errors = [];

  for (const calId of targetCalendars) {
    try {
      const token = await getToken({ impersonate: calId, scope: CALENDAR_SCOPE });
      const events = await listCalendarEvents({ calendarId: calId, token, now, hours, fetchImpl });
      for (const ev of events) {
        if (isTargetEvent(ev, { staffAddresses, ownerEmail: calId, now, hours })) {
          rawTargetEvents.push({ event: ev, calendarId: calId });
        }
      }
    } catch (err) {
      console.error(`[meet-cue-scheduler] カレンダー取得エラー (${calId}):`, err.message);
      errors.push({ calendarId: calId, error: err.message });
    }
  }

  const targetEvents = deduplicateEvents(rawTargetEvents);
  console.log(`[meet-cue-scheduler] 対象 Meet 予定: ${targetEvents.length}件`);

  // Load inquiry sheet data once if available
  let sheetValues = [];
  try {
    sheetValues = await sheetReader(INQUIRY_SHEET, INQUIRY_TAB, { getToken, fetchImpl });
  } catch (err) {
    console.error('[meet-cue-scheduler] 問い合わせ台帳読み込み警告:', err.message);
  }

  const plannedActions = [];

  for (const { event, calendarId } of targetEvents) {
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
    let companionEventId = itemState.companionEventId;

    if (!docId && !dryRun) {
      try {
        console.log(`[meet-cue-scheduler] カンペ Doc 作成開始: "${event.summary}" (${staffEmail})`);
        const docInfo = await setupCueDocument({
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

        // Create companion event on Calendar
        const calToken = await getToken({ impersonate: calendarId, scope: CALENDAR_SCOPE });
        const companion = await createOrUpdateCompanionEvent({
          token: calToken,
          calendarId,
          originalEvent: event,
          docUrl: docInfo.staffUrl,
          orgiastAttendees,
          fetchImpl,
        });

        companionEventId = companion.id;
        itemState.companionEventId = companionEventId;
        itemState.prepared = true;
      } catch (err) {
        console.error(`[meet-cue-scheduler] 準備失敗 (${event.summary}):`, err.message);
        errors.push({ event: event.summary, stage: 'prep', error: err.message });
      }
    }

    // 1b. Join Meet Window check: start - 2 min to start + 10 min
    const nowMs = now.getTime();
    const windowStart = startMs - 2 * 60 * 1000;
    const windowEnd = startMs + 10 * 60 * 1000;
    const inJoinWindow = nowMs >= windowStart && nowMs <= windowEnd;

    let actionStatus = 'idle';

    if (inJoinWindow) {
      const pidAlive = isPidAlive(itemState.joinedPid);
      if (pidAlive) {
        actionStatus = 'running';
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
            const scriptPath = path.join(path.dirname(import.meta.url.replace('file://', '')), 'meet-cue.mjs');
            const args = [
              scriptPath,
              'start',
              '--url', meetInfo.meetUrl,
              '--staff', staffEmail,
              '--title', event.summary || '打合せ',
              '--cards-file', itemState.cardsFile,
              '--doc-id', docId,
              '--brief-file', itemState.briefFile || '',
              '--max-minutes', String(durationMinutes + 30),
            ];

            const child = spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: 'ignore' });

            child.unref();

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

    state[eventKey] = itemState;

    plannedActions.push({
      eventKey,
      title: event.summary,
      startTime: startIso,
      meetUrl: meetInfo.meetUrl,
      staffEmail,
      prepared: Boolean(itemState.prepared || docId),
      docId: docId || null,
      companionEventId: companionEventId || null,
      inJoinWindow,
      actionStatus,
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
    errors,
  };
}

export async function main(argv = process.argv.slice(2)) {
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

    if (!result.ok) {
      process.exit(1);
    }
  } catch (err) {
    console.error('meet-cue-scheduler 致命的エラー:', err);
    process.exit(1);
  }
}

if (isEntry(import.meta.url)) {
  main();
}
