import { getDriveToken } from '../tools/lib/drive-auth.mjs';

async function main() {
  try {
    const token = await getDriveToken({ scope: 'https://www.googleapis.com/auth/calendar.readonly', impersonate: 'kim@orgiast.jp' });
    const timeMin = new Date('2026-10-26T00:00:00+09:00').toISOString();
    const timeMax = new Date('2026-10-26T23:59:59+09:00').toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${encodeURIComponent(timeMin)}&timeMax=${encodeURIComponent(timeMax)}&singleEvents=true&orderBy=startTime`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    console.log('Status:', res.status);
    const data = await res.json();
    console.log('Events:', data.items?.map(e => ({ id: e.id, summary: e.summary, start: e.start, hangoutLink: e.hangoutLink })));
  } catch (err) {
    console.error(err.message);
  }
}

main();
