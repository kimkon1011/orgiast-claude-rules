import test from 'node:test';
import assert from 'node:assert/strict';
import { listCalendarEvents, runCalendarEventsList } from './calendar-events-list.mjs';

test('events.list is GET-only, paginates, and emits attendee domains', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push(String(url));
    assert.equal(options.method, 'GET');
    const second = new URL(url).searchParams.has('pageToken');
    return Response.json(second
      ? { items: [{ id: 'e2', start: { date: '2026-11-02' }, summary: '二日目' }] }
      : { items: [{ id: 'e1', start: { dateTime: '2026-11-01T10:00:00+09:00' }, summary: '定例', attendees: [{ email: 'a@Example.COM' }, { email: 'b@example.com' }] }], nextPageToken: 'next' });
  };
  const events = await listCalendarEvents({ from: '2026-11-01', to: '2026-11-03', getToken: async options => { assert.equal(options.impersonate, 'seisaku-team@orgiast.jp'); assert.match(options.scope, /calendar\.readonly$/); return 'token'; }, fetchImpl });
  assert.equal(calls.length, 2);
  assert.deepEqual(events[0].attendeeDomains, ['example.com']);
});

test('CLI validates date arguments before authentication', async () => {
  await assert.rejects(runCalendarEventsList(['--from', 'bad', '--to', '2026-11-03'], { getToken: async () => assert.fail('must not authenticate') }), /使い方/);
});
