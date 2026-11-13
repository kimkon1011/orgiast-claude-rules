#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';
const USER = 'kim@orgiast.jp';
const RECORDER_EMAIL = 'seisaku-team@orgiast.jp';
const HOUR = 3600000;
const DAY = 24 * HOUR;
const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

function acquireLock(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'run.lock');
  try { fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('meet-recorder-invite: invalid run.lock');
    try { process.kill(pid, 0); throw new Error('meet-recorder-invite is already running'); }
    catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
    fs.unlinkSync(file);
    fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  }
  return () => fs.unlinkSync(file);
}

function appendLog(file, record) {
  const fd = fs.openSync(file, 'a', 0o600);
  try { fs.writeSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function iso(time) {
  return new Date(time).toISOString();
}

function clean(value) {
  return String(value ?? '').replace(/[\r\n<>]/g, ' ').trim();
}

function hasMeetLink(event) {
  if (event.hangoutLink) return true;
  if (event.conferenceData?.conferenceSolution?.key?.type === 'hangoutsMeet') return true;
  return false;
}

function isNoRecord(text) {
  const t = String(text ?? '').normalize('NFKC').toLowerCase();
  return /録画不要|録画しない|no-record|no[\uFF0D\-]record/i.test(t);
}

function isInternalOnly(attendees) {
  if (!attendees || !attendees.length) return true;
  return attendees.every(a => {
    if (a.self) return true;
    if (a.resource) return true;
    if (!a.email) return true;
    return a.email.toLowerCase().endsWith('@orgiast.jp');
  });
}

function hasRecorder(attendees) {
  if (!attendees) return false;
  return attendees.some(a => a.email && a.email.toLowerCase() === RECORDER_EMAIL.toLowerCase());
}

function isMeePrefix(summary) {
  const t = String(summary ?? '').normalize('NFKC');
  return /^\s*M\s*[:：]/i.test(t);
}

function isTargetEvent(event) {
  if (event.status === 'cancelled') return false;
  if (!hasMeetLink(event)) return false;
  if (!event.organizer?.self) return false;
  const visibility = event.visibility || 'default';
  if (visibility === 'private' || visibility === 'confidential') return false;
  const text = `${event.summary || ''} ${event.description || ''}`;
  if (isNoRecord(text)) return false;
  const attendees = event.attendees || [];
  if (hasRecorder(attendees)) return false;

  // Count non-kim, non-resource attendees
  const others = (attendees || []).filter(a => {
    if (a.self) return false;
    if (a.resource) return false;
    if (!a.email) return false;
    return true;
  });

  if (others.length === 0) {
    // No other human attendees — only target if title starts with M：/M:
    return isMeePrefix(event.summary);
  }

  // Has other attendees — target only if at least one is external
  return !isInternalOnly(attendees);
}

function buildPatchBody(event) {
  const existing = (event.attendees || []).map(a => {
    const entry = { email: a.email };
    if (a.displayName) entry.displayName = a.displayName;
    if (a.responseStatus) entry.responseStatus = a.responseStatus;
    if (a.organizer) entry.organizer = a.organizer;
    if (a.resource) entry.resource = a.resource;
    if (a.optional) entry.optional = a.optional;
    if (a.comment) entry.comment = a.comment;
    if (a.additionalGuests != null) entry.additionalGuests = a.additionalGuests;
    return entry;
  });
  existing.push({ email: RECORDER_EMAIL });
  return { attendees: existing };
}

async function listAllEvents(token, days, fetchImpl = globalThis.fetch) {
  const now = Date.now();
  const timeMin = iso(now);
  const timeMax = iso(now + days * DAY);
  const items = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      timeMin, timeMax,
      singleEvents: 'true',
      maxResults: '2500',
      showDeleted: 'false',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `${API}?${params}`;
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Calendar API list ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const page = await res.json();
    items.push(...(page.items || []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

async function patchEvent(id, body, token, fetchImpl = globalThis.fetch) {
  const url = `${API}/${encodeURIComponent(id)}?sendUpdates=none`;
  const res = await fetchImpl(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Calendar API PATCH ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

async function getEvent(id, token, fetchImpl = globalThis.fetch) {
  const url = `${API}/${encodeURIComponent(id)}`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Calendar API GET ${res.status}: ${(await res.text()).slice(0, 500)}`);
  return res.json();
}

export { isTargetEvent, buildPatchBody, hasMeetLink, isNoRecord, isInternalOnly, hasRecorder, isMeePrefix };

export async function run(options = {}, deps = {}) {
  const home = options.home || process.env.ORGIAST_HOME || os.homedir();
  const dir = options.stateDir || path.join(home, '.claude', 'meet-recorder-invite');
  const days = options.days ?? 14;
  const dryRun = Boolean(options.dryRun);
  const now = options.now ?? Date.now();
  const log = deps.log || console.error;
  const fetchImpl = deps.fetchImpl || globalThis.fetch;

  const release = acquireLock(path.join(os.tmpdir(), 'meet-recorder-invite-locks', crypto.createHash('sha256').update(path.resolve(dir)).digest('hex')));
  try {
    const logFile = path.join(home, '.claude', 'logs', 'meet-recorder-invite.jsonl');
    fs.mkdirSync(path.dirname(logFile), { recursive: true, mode: 0o700 });

    const getToken = deps.getToken || (async () => {
      const { getDriveToken } = await import('./lib/drive-auth.mjs');
      return getDriveToken({ impersonate: USER, scope: CALENDAR_SCOPE, signal: AbortSignal.timeout(30000) });
    });
    const token = await getToken();

    const events = deps.events || await listAllEvents(token, days, fetchImpl);
    const targets = events.filter(isTargetEvent);

    const result = {
      at: new Date(now).toISOString(),
      totalEvents: events.length,
      targetCount: targets.length,
      patched: 0,
      failed: 0,
      details: [],
    };

    for (const event of targets) {
      const id = event.id;
      const summary = clean(event.summary || '(無題)');
      const start = event.start?.dateTime || event.start?.date || '';
      const detail = { id, start, summary };

      if (dryRun) {
        result.details.push(detail);
        continue;
      }

      try {
        const body = buildPatchBody(event);
        await patchEvent(id, body, token, fetchImpl);

        // Read-back verification
        const updated = await getEvent(id, token, fetchImpl);
        const attendees = updated.attendees || [];
        if (!attendees.some(a => a.email === RECORDER_EMAIL)) {
          throw new Error('read-back: seisaku-team not found after PATCH');
        }

        result.patched++;
        result.details.push(detail);
      } catch (error) {
        result.failed++;
        result.details.push({ ...detail, error: error.message });
        log(`meet-recorder-invite: FAILED ${id} (${summary}): ${error.message}`);
      }
    }

    appendLog(logFile, { ...result, dryRun });

    if (result.failed > 0) {
      throw new Error(`meet-recorder-invite: ${result.failed} failures out of ${targets.length} targets`);
    }

    return result;
  } finally {
    release();
  }
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const daysIndex = args.indexOf('--days');
  const days = daysIndex >= 0 ? Number(args[daysIndex + 1]) : 14;

  run({ dryRun, days }).then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (result.failed > 0) process.exitCode = 1;
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}