#!/usr/bin/env node
import { getDriveToken } from './lib/drive-auth.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { isEntry } from './is-entry.mjs';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const USER = 'seisaku-team@orgiast.jp';

function domain(email) {
  const at = String(email || '').lastIndexOf('@');
  return at < 0 ? null : email.slice(at + 1).toLowerCase();
}

export function compactEvent(event) {
  return {
    eventId: event.id || '',
    start: event.start?.dateTime || event.start?.date || null,
    summary: event.summary || '',
    attendeeDomains: [...new Set((event.attendees || []).map(item => domain(item.email)).filter(Boolean))].sort(),
  };
}

export async function listCalendarEvents({ from, to, fetchImpl = gwsFetch, getToken = getDriveToken }) {
  const token = await getToken({ impersonate: USER, scope: SCOPE, signal: AbortSignal.timeout(30000) });
  const items = [];
  let pageToken;
  do {
    const params = new URLSearchParams({
      timeMin: `${from}T00:00:00+09:00`,
      timeMax: `${to}T23:59:59+09:00`,
      singleEvents: 'true', orderBy: 'startTime', maxResults: '2500',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`;
    const response = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw Object.assign(new Error(`Calendar API ${response.status}: ${(await response.text()).slice(0, 500)}`), { status: response.status });
    const page = await response.json();
    items.push(...(page.items || []).map(compactEvent));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
}

export async function runCalendarEventsList(args, deps = {}) {
  const value = flag => { const i = args.indexOf(flag); return i < 0 ? null : args[i + 1]; };
  const from = value('--from'), to = value('--to');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(to || '')) throw new Error('使い方: node tools/calendar-events-list.mjs --from YYYY-MM-DD --to YYYY-MM-DD');
  const events = await listCalendarEvents({ from, to, ...deps });
  (deps.stdout || console.log)(JSON.stringify(events, null, 2));
  return 0;
}

if (isEntry(import.meta.url)) {
  runCalendarEventsList(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
