import test from 'node:test';
import assert from 'node:assert/strict';
import { runCalendarFreeSlots } from './calendar-free-slots.mjs';

/** Mock Response for fetch stubs */
function mockResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const publicApiResponse = {
  days: [
    { date: '2026-11-26', dayLabel: '11/26(木)', slots: [{ start: '09:00', end: '10:00' }, { start: '13:00', end: '14:00' }] },
    { date: '2026-11-27', dayLabel: '11/27(金)', slots: [{ start: '10:00', end: '11:30' }] },
  ],
  text: 'test',
  calendars: ['kim', 'seisaku-team'],
  calendarLabels: ['金 功勇', '制作全般'],
  excluded: [],
  generatedAt: '2026-11-21T00:00:00Z',
  freshness: 'ok',
};

const baseOpts = {
  from: '2026-11-26', to: '2026-11-27',
  mode: 'online', region: '大阪',
  start: '09:00', end: '18:00',
  min: 30, calendars: ['kim@orgiast.jp', 'seisaku-team@orgiast.jp'],
  json: false, fixture: null, weekends: false,
  source: 'auto',
};

test('gws が 403 を投げたら public API へフォールバックし空き枠が表示される', async () => {
  const gwsError = new Error('channel gws: HTTP 403 {"error":"GWS request rejected or upstream unavailable"}');
  let publicCalled = false;

  const result = await runCalendarFreeSlots(baseOpts, {
    gwsFetchImpl: () => { throw gwsError; },
    fetchImpl: (url) => {
      publicCalled = true;
      assert.match(url, /secretary\/api\/public\/free/);
      return mockResponse(publicApiResponse);
    },
    warn: () => {},
    token: 'mock-token',
  });

  assert.equal(publicCalled, true, 'public API should be called after gws 403');
  assert.match(result, /11月26日/);
  assert.match(result, /09:00〜10:00/);
  assert.match(result, /13:00〜14:00/);
  assert.match(result, /11月27日/);
  assert.match(result, /10:00〜11:30/);
});

test('gws が成功したら public API を呼ばない', async () => {
  let publicCalled = false;

  const result = await runCalendarFreeSlots(baseOpts, {
    gwsFetchImpl: () => mockResponse({ items: [] }),
    fetchImpl: () => { publicCalled = true; return mockResponse(publicApiResponse); },
    warn: () => {},
    token: 'mock-token',
  });

  assert.equal(publicCalled, false, 'public API should NOT be called when gws succeeds');
  assert.ok(result.length > 0, 'should produce output');
});

test('--source public は gws を呼ばず public API を使う', async () => {
  let gwsCalled = false;

  const result = await runCalendarFreeSlots({ ...baseOpts, source: 'public' }, {
    gwsFetchImpl: () => { gwsCalled = true; return mockResponse({ items: [] }); },
    fetchImpl: () => mockResponse(publicApiResponse),
    warn: () => {},
    token: 'mock-token',
  });

  assert.equal(gwsCalled, false, 'gws should NOT be called when source=public');
  assert.match(result, /11月26日/);
  assert.match(result, /09:00〜10:00/);
});

test('gws のエラーが GWS 拒否でない場合は再スローする', async () => {
  const networkError = new Error('Network timeout');

  await assert.rejects(
    () => runCalendarFreeSlots(baseOpts, {
      gwsFetchImpl: () => { throw networkError; },
      fetchImpl: () => mockResponse(publicApiResponse),
      token: 'mock-token',
    }),
    /Network timeout/,
  );
});

test('--source gws のときは GWS 拒否エラーでも再スローする', async () => {
  const gwsError = new Error('channel gws: HTTP 403 {"error":"GWS request rejected or upstream unavailable"}');

  await assert.rejects(
    () => runCalendarFreeSlots({ ...baseOpts, source: 'gws' }, {
      gwsFetchImpl: () => { throw gwsError; },
      fetchImpl: () => mockResponse(publicApiResponse),
      token: 'mock-token',
    }),
    /GWS request rejected/,
  );
});

test('フォールバック時は JSON 出力に warnings が含まれる', async () => {
  const gwsError = new Error('channel gws: HTTP 403 {"error":"GWS request rejected or upstream unavailable"}');

  const result = await runCalendarFreeSlots({ ...baseOpts, json: true }, {
    gwsFetchImpl: () => { throw gwsError; },
    fetchImpl: () => mockResponse(publicApiResponse),
    warn: () => {},
    token: 'mock-token',
  });

  assert.ok(Array.isArray(result.warnings), 'warnings should be an array');
  assert.ok(result.warnings.some(w => w.includes('public API')), 'warnings should mention public API');
  assert.deepEqual(result.sources, {});
});

test('--source public + JSON 出力に warnings が含まれる', async () => {
  const result = await runCalendarFreeSlots({ ...baseOpts, source: 'public', json: true }, {
    fetchImpl: () => mockResponse(publicApiResponse),
    token: 'mock-token',
  });

  assert.ok(Array.isArray(result.warnings), 'warnings should be an array');
  assert.ok(result.warnings.some(w => w.includes('public API')), 'warnings should mention public API');
});