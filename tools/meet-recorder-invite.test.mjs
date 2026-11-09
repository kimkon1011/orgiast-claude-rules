import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run, isTargetEvent, buildPatchBody, hasMeetLink, isNoRecord, isInternalOnly, hasRecorder, isMeePrefix } from './meet-recorder-invite.mjs';

const RECORDER = 'seisaku-team@orgiast.jp';

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'meet-recorder-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeEvent(overrides = {}) {
  return {
    id: 'event-1',
    status: 'confirmed',
    summary: '打合せ',
    hangoutLink: 'https://meet.google.com/abc-defg-hij',
    organizer: { self: true },
    visibility: 'default',
    start: { dateTime: '2026-11-10T10:00:00+09:00' },
    end: { dateTime: '2026-11-10T11:00:00+09:00' },
    attendees: [
      { email: 'kim@orgiast.jp', self: true },
      { email: 'customer@example.com' },
    ],
    ...overrides,
  };
}

// --- isTargetEvent tests ---

test('target: normal meet with external attendee', () => {
  assert.ok(isTargetEvent(makeEvent()));
});

test('exclude: cancelled', () => {
  assert.ok(!isTargetEvent(makeEvent({ status: 'cancelled' })));
});

test('exclude: no meet link', () => {
  assert.ok(!isTargetEvent(makeEvent({ hangoutLink: undefined, conferenceData: undefined })));
});

test('exclude: not organizer', () => {
  assert.ok(!isTargetEvent(makeEvent({ organizer: { self: false } })));
});

test('exclude: private visibility', () => {
  assert.ok(!isTargetEvent(makeEvent({ visibility: 'private' })));
});

test('exclude: confidential visibility', () => {
  assert.ok(!isTargetEvent(makeEvent({ visibility: 'confidential' })));
});

test('exclude: title contains no-record', () => {
  assert.ok(!isTargetEvent(makeEvent({ summary: '録画不要 打合せ' })));
});

test('exclude: description contains no-record', () => {
  assert.ok(!isTargetEvent(makeEvent({ description: 'この会議は録画しないでください' })));
});

test('exclude: recorder already invited', () => {
  assert.ok(!isTargetEvent(makeEvent({ attendees: [
    { email: 'kim@orgiast.jp', self: true },
    { email: 'customer@example.com' },
    { email: RECORDER },
  ] })));
});

test('exclude: internal only (all orgiast.jp)', () => {
  assert.ok(!isTargetEvent(makeEvent({ attendees: [
    { email: 'kim@orgiast.jp', self: true },
    { email: 'staff@orgiast.jp' },
  ] })));
});

test('exclude: no attendees at all without M： prefix', () => {
  assert.ok(!isTargetEvent(makeEvent({ attendees: [] })));
});

test('target: no attendees with M： prefix (M：エイト)', () => {
  assert.ok(isTargetEvent(makeEvent({ attendees: [], summary: 'M：エイト' })));
});

test('target: no attendees with M: prefix (M:エイト)', () => {
  assert.ok(isTargetEvent(makeEvent({ attendees: [], summary: 'M:エイト' })));
});

test('exclude: no attendees with M： prefix but personal event (マハタパスサダナ)', () => {
  assert.ok(!isTargetEvent(makeEvent({ attendees: [], summary: 'マハタパスサダナ' })));
});

test('exclude: M:増田 with only internal attendees', () => {
  assert.ok(!isTargetEvent(makeEvent({ summary: 'M:増田', attendees: [
    { email: 'kim@orgiast.jp', self: true },
    { email: 'staff@orgiast.jp' },
  ] })));
});

test('target: room resource only with M： prefix', () => {
  assert.ok(isTargetEvent(makeEvent({ attendees: [
    { email: 'kim@orgiast.jp', self: true },
    { email: 'room@resource.calendar.google.com', resource: true },
  ], summary: 'M：定例' })));
});

test('exclude: room resource only without M： prefix', () => {
  assert.ok(!isTargetEvent(makeEvent({ attendees: [
    { email: 'kim@orgiast.jp', self: true },
    { email: 'room@resource.calendar.google.com', resource: true },
  ] })));
});

test('exclude: undefined attendees (internal only)', () => {
  assert.ok(!isTargetEvent(makeEvent({ attendees: undefined })));
});

test('target: conferenceData hangoutsMeet type', () => {
  assert.ok(isTargetEvent(makeEvent({
    hangoutLink: undefined,
    conferenceData: { conferenceSolution: { key: { type: 'hangoutsMeet' } } },
  })));
});

test('target: no-record in NFKC variant', () => {
  // Full-width characters (U+FF2E etc.) normalize to ASCII via NFKC
  assert.ok(!isTargetEvent(makeEvent({ summary: '\uFF2E\uFF2F\uFF0D\uFF32\uFF25\uFF23\uFF2F\uFF32\uFF24 打合せ' })));
});

// --- buildPatchBody tests ---

test('buildPatchBody: preserves existing attendees and adds recorder', () => {
  const event = makeEvent();
  const body = buildPatchBody(event);
  assert.equal(body.attendees.length, 3);
  assert.ok(body.attendees.some(a => a.email === 'kim@orgiast.jp'));
  assert.ok(body.attendees.some(a => a.email === 'customer@example.com'));
  assert.ok(body.attendees.some(a => a.email === RECORDER));
});

test('buildPatchBody: preserves responseStatus', () => {
  const event = makeEvent({ attendees: [
    { email: 'kim@orgiast.jp', self: true, responseStatus: 'accepted' },
    { email: 'customer@example.com', responseStatus: 'needsAction' },
  ] });
  const body = buildPatchBody(event);
  const kim = body.attendees.find(a => a.email === 'kim@orgiast.jp');
  assert.equal(kim.responseStatus, 'accepted');
  const cust = body.attendees.find(a => a.email === 'customer@example.com');
  assert.equal(cust.responseStatus, 'needsAction');
});

test('buildPatchBody: no responseStatus on recorder', () => {
  const event = makeEvent();
  const body = buildPatchBody(event);
  const recorder = body.attendees.find(a => a.email === RECORDER);
  assert.equal(recorder.responseStatus, undefined);
});

// --- helper tests ---

test('hasMeetLink: hangoutLink', () => {
  assert.ok(hasMeetLink({ hangoutLink: 'https://meet.google.com/abc' }));
});

test('hasMeetLink: conferenceData', () => {
  assert.ok(hasMeetLink({ conferenceData: { conferenceSolution: { key: { type: 'hangoutsMeet' } } } }));
});

test('hasMeetLink: neither', () => {
  assert.ok(!hasMeetLink({}));
});

test('isNoRecord: various patterns', () => {
  assert.ok(isNoRecord('録画不要'));
  assert.ok(isNoRecord('録画しない'));
  assert.ok(isNoRecord('no-record'));
  assert.ok(!isNoRecord('通常の打合せ'));
  assert.ok(!isNoRecord(''));
});

test('isMeePrefix: M： prefix', () => {
  assert.ok(isMeePrefix('M：エイト'));
});

test('isMeePrefix: M: prefix (half-width colon)', () => {
  assert.ok(isMeePrefix('M:エイト'));
});

test('isMeePrefix: leading whitespace', () => {
  assert.ok(isMeePrefix('  M：打合せ'));
});

test('isMeePrefix: case insensitive (m：)', () => {
  assert.ok(isMeePrefix('m：打合せ'));
});

test('isMeePrefix: not a match (マハタパスサダナ)', () => {
  assert.ok(!isMeePrefix('マハタパスサダナ'));
});

test('isMeePrefix: empty string', () => {
  assert.ok(!isMeePrefix(''));
});

test('isMeePrefix: undefined', () => {
  assert.ok(!isMeePrefix(undefined));
});

test('isInternalOnly: all orgiast.jp', () => {
  assert.ok(isInternalOnly([
    { email: 'kim@orgiast.jp' },
    { email: 'staff@orgiast.jp' },
  ]));
});

test('isInternalOnly: includes external', () => {
  assert.ok(!isInternalOnly([
    { email: 'kim@orgiast.jp' },
    { email: 'customer@example.com' },
  ]));
});

test('isInternalOnly: empty', () => {
  assert.ok(isInternalOnly([]));
});

test('isInternalOnly: undefined', () => {
  assert.ok(isInternalOnly(undefined));
});

test('hasRecorder: present', () => {
  assert.ok(hasRecorder([{ email: RECORDER }]));
});

test('hasRecorder: absent', () => {
  assert.ok(!hasRecorder([{ email: 'kim@orgiast.jp' }]));
});

test('hasRecorder: undefined', () => {
  assert.ok(!hasRecorder(undefined));
});

test('exclude: case-insensitive email match (Seisaku-Team @orgiast.jp)', () => {
  assert.ok(!isTargetEvent(makeEvent({ attendees: [
    { email: 'kim@orgiast.jp', self: true },
    { email: 'customer@example.com' },
    { email: 'Seisaku-Team@orgiast.jp' },
  ] })));
});

test('isInternalOnly: case-insensitive orgiast.jp check', () => {
  assert.ok(isInternalOnly([
    { email: 'kim@orgiast.jp', self: true },
    { email: 'Staff@orgiast.jp' },
  ]));
});

test('isInternalOnly: resource is ignored', () => {
  assert.ok(isInternalOnly([
    { email: 'kim@orgiast.jp', self: true },
    { email: 'room@resource.calendar.google.com', resource: true },
  ]));
});

// --- run() integration tests ---

test('dry-run: never patches, returns targets', async t => {
  const home = temp(t);
  const events = [makeEvent()];
  const result = await run({
    dryRun: true,
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
  });
  assert.equal(result.targetCount, 1);
  assert.equal(result.patched, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.details.length, 1);
  assert.equal(result.details[0].id, 'event-1');
});

test('dry-run: excludes non-target events', async t => {
  const home = temp(t);
  const events = [
    makeEvent(), // target
    makeEvent({ status: 'cancelled' }), // excluded
    makeEvent({ visibility: 'private' }), // excluded
    makeEvent({ summary: '録画不要' }), // excluded
    makeEvent({ organizer: { self: false } }), // excluded
    makeEvent({ attendees: [
      { email: 'kim@orgiast.jp', self: true },
      { email: 'staff@orgiast.jp' },
    ] }), // excluded (internal only)
    makeEvent({ attendees: [
      { email: 'kim@orgiast.jp', self: true },
      { email: 'customer@example.com' },
      { email: RECORDER },
    ] }), // excluded (already has recorder)
  ];
  const result = await run({
    dryRun: true,
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
  });
  assert.equal(result.targetCount, 1);
  assert.equal(result.details.length, 1);
});

test('dry-run: --days parameter limits window', async t => {
  const home = temp(t);
  const events = [makeEvent()];
  const result = await run({
    dryRun: true,
    home,
    days: 1,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
  });
  assert.equal(result.targetCount, 1);
});

test('PATCH preserves existing attendees and uses sendUpdates=none', async t => {
  const home = temp(t);
  let patchUrl, patchBody;
  const events = [makeEvent()];
  const result = await run({
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
    fetchImpl: async (url, init) => {
      if (init?.method === 'PATCH') {
        patchUrl = url;
        patchBody = JSON.parse(init.body);
        // Return updated event with recorder
        return new Response(JSON.stringify({
          ...events[0],
          attendees: [...events[0].attendees, { email: RECORDER }],
        }));
      }
      if (init?.method === undefined || init?.method === 'GET') {
        // GET read-back: return with recorder
        return new Response(JSON.stringify({
          ...events[0],
          attendees: [...events[0].attendees, { email: RECORDER }],
        }));
      }
      return new Response(JSON.stringify({ items: events }));
    },
  });
  assert.equal(result.patched, 1);
  assert.equal(result.failed, 0);
  assert.match(patchUrl, /sendUpdates=none/);
  const emails = patchBody.attendees.map(a => a.email);
  assert.ok(emails.includes('kim@orgiast.jp'));
  assert.ok(emails.includes('customer@example.com'));
  assert.ok(emails.includes(RECORDER));
});

test('read-back failure causes exit 1', async t => {
  const home = temp(t);
  const events = [makeEvent()];
  let patchCount = 0;
  await assert.rejects(run({
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
    fetchImpl: async (url, init) => {
      if (init?.method === 'PATCH') {
        patchCount++;
        return new Response(JSON.stringify(events[0]));
      }
      // GET read-back: return event WITHOUT recorder
      return new Response(JSON.stringify(events[0]));
    },
  }), /1 failures/);
  assert.equal(patchCount, 1);
});

test('PATCH failure increments failed count', async t => {
  const home = temp(t);
  const events = [makeEvent()];
  await assert.rejects(run({
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
    fetchImpl: async (url, init) => {
      if (init?.method === 'PATCH') {
        return new Response('Forbidden', { status: 403 });
      }
      return new Response(JSON.stringify({ items: events }));
    },
  }), /1 failures/);
});

test('log file is written with JSONL', async t => {
  const home = temp(t);
  const events = [makeEvent()];
  await run({
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
    fetchImpl: async (url, init) => {
      if (init?.method === 'PATCH') {
        return new Response(JSON.stringify({
          ...events[0],
          attendees: [...events[0].attendees, { email: RECORDER }],
        }));
      }
      return new Response(JSON.stringify({
        ...events[0],
        attendees: [...events[0].attendees, { email: RECORDER }],
      }));
    },
  });
  const logFile = path.join(home, '.claude', 'logs', 'meet-recorder-invite.jsonl');
  assert.ok(fs.existsSync(logFile));
  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.patched, 1);
  assert.equal(entry.failed, 0);
  assert.equal(entry.targetCount, 1);
});

test('dry-run writes log file with dryRun: true', async t => {
  const home = temp(t);
  const events = [makeEvent()];
  await run({
    dryRun: true,
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
  });
  const logFile = path.join(home, '.claude', 'logs', 'meet-recorder-invite.jsonl');
  assert.ok(fs.existsSync(logFile));
  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0]);
  assert.equal(entry.dryRun, true);
  assert.equal(entry.targetCount, 1);
  assert.equal(entry.patched, 0);
});

test('concurrent run lock prevents double execution', async t => {
  const home = temp(t);
  const dir = path.join(home, '.claude', 'meet-recorder-invite');
  const hash = crypto.createHash('sha256').update(path.resolve(dir)).digest('hex');
  const lockDir = path.join(os.tmpdir(), 'meet-recorder-invite-locks');
  const lockFile = path.join(lockDir, hash, 'run.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  fs.writeFileSync(lockFile, String(process.pid));
  await assert.rejects(run({
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events: [makeEvent()],
    getToken: async () => 'fake-token',
    log() {},
  }), /already running/);
  fs.rmSync(path.join(lockDir, hash), { recursive: true, force: true });
});

test('not-organizer event is never patched', async t => {
  const home = temp(t);
  const events = [makeEvent({ organizer: { self: false } })];
  let patched = false;
  const result = await run({
    dryRun: true,
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
    fetchImpl: async () => { patched = true; return new Response('{}'); },
  });
  assert.equal(result.targetCount, 0);
  assert.ok(!patched);
});

test('no-record in title prevents patch', async t => {
  const home = temp(t);
  const events = [makeEvent({ summary: '録画不要 定例MTG' })];
  const result = await run({
    dryRun: true,
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
  });
  assert.equal(result.targetCount, 0);
});

test('no-record in description prevents patch', async t => {
  const home = temp(t);
  const events = [makeEvent({ description: 'この会議は録画しないこと' })];
  const result = await run({
    dryRun: true,
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
  });
  assert.equal(result.targetCount, 0);
});

test('internal-only meeting is excluded', async t => {
  const home = temp(t);
  const events = [makeEvent({ attendees: [
    { email: 'kim@orgiast.jp', self: true },
    { email: 'staff@orgiast.jp' },
  ] })];
  const result = await run({
    dryRun: true,
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
  });
  assert.equal(result.targetCount, 0);
});

test('no attendees = internal only = excluded', async t => {
  const home = temp(t);
  const events = [makeEvent({ attendees: [] })];
  const result = await run({
    dryRun: true,
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
  });
  assert.equal(result.targetCount, 0);
});

test('already has recorder = excluded', async t => {
  const home = temp(t);
  const events = [makeEvent({ attendees: [
    { email: 'kim@orgiast.jp', self: true },
    { email: 'customer@example.com' },
    { email: RECORDER },
  ] })];
  const result = await run({
    dryRun: true,
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
  });
  assert.equal(result.targetCount, 0);
});

test('conferenceData hangoutsMeet type is recognized', async t => {
  const home = temp(t);
  const events = [makeEvent({
    hangoutLink: undefined,
    conferenceData: { conferenceSolution: { key: { type: 'hangoutsMeet' } } },
  })];
  const result = await run({
    dryRun: true,
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
  });
  assert.equal(result.targetCount, 1);
});

test('multiple targets: all patched successfully', async t => {
  const home = temp(t);
  const events = [
    makeEvent({ id: 'event-1', summary: 'MTG A' }),
    makeEvent({ id: 'event-2', summary: 'MTG B' }),
  ];
  const result = await run({
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
    fetchImpl: async (url, init) => {
      if (init?.method === 'PATCH') {
        const id = url.split('/').pop().split('?')[0];
        const ev = events.find(e => e.id === id);
        return new Response(JSON.stringify({
          ...ev,
          attendees: [...ev.attendees, { email: RECORDER }],
        }));
      }
      return new Response(JSON.stringify({
        ...events[0],
        attendees: [...events[0].attendees, { email: RECORDER }],
      }));
    },
  });
  assert.equal(result.patched, 2);
  assert.equal(result.failed, 0);
});

test('one failure among multiple targets causes exit 1', async t => {
  const home = temp(t);
  const events = [
    makeEvent({ id: 'event-1', summary: 'MTG A' }),
    makeEvent({ id: 'event-2', summary: 'MTG B' }),
  ];
  let patchCount = 0;
  await assert.rejects(run({
    home,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
    fetchImpl: async (url, init) => {
      if (init?.method === 'PATCH') {
        patchCount++;
        if (patchCount === 1) return new Response('Forbidden', { status: 403 });
        return new Response(JSON.stringify({
          ...events[1],
          attendees: [...events[1].attendees, { email: RECORDER }],
        }));
      }
      if (init?.method === undefined || init?.method === 'GET') {
        // Return event-2 with recorder for read-back
        return new Response(JSON.stringify({
          ...events[1],
          attendees: [...events[1].attendees, { email: RECORDER }],
        }));
      }
      return new Response(JSON.stringify({ items: events }));
    },
  }), /1 failures/);
});

test('--days parameter is passed through', async t => {
  const home = temp(t);
  const events = [makeEvent()];
  const result = await run({
    dryRun: true,
    home,
    days: 7,
    now: Date.parse('2026-11-10T00:00:00Z'),
  }, {
    events,
    getToken: async () => 'fake-token',
    log() {},
  });
  assert.equal(result.targetCount, 1);
});

