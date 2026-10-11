import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const mailSource = fs.readFileSync(new URL('../gas/fleet-status-sheet/Mail.gs', import.meta.url), 'utf8');
const beaconSource = fs.readFileSync(new URL('../gas/fleet-status-sheet/Beacon.gs', import.meta.url), 'utf8');
const webSource = fs.readFileSync(new URL('../gas/fleet-status-sheet/WebApp.gs', import.meta.url), 'utf8').replaceAll('\r\n', '\n');

// Mail.gs と Beacon.gs を同一コンテキストに読み込む。シートは名前ごとに独立した行配列を持つ。
function harness({ withMail = true, withBeacon = true } = {}) {
  const sheets = new Map();
  let flushes = 0, locked = false, available = true, silent = false;
  const makeSheet = (name) => {
    const rows = [];
    const sheet = {
      name, rows,
      getLastRow: () => rows.length, setFrozenRows: () => {}, deleteRow: n => rows.splice(n - 1, 1),
      getRange(row, col, count, width) {
        return {
          getValues: () => Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => rows[row - 1 + i]?.[col - 1 + j] || '')),
          setRichTextValues(values) { assert.equal(locked, true); if (!silent) values.forEach((v, i) => { rows[row - 1 + i] = v.map(x => x.text); }); }
        };
      }
    };
    return sheet;
  };
  const properties = { SHEET_ID: 'sheet-id', FLEET_TOKEN: 'sheet-id' };
  const context = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] || null, setProperty: (key, value) => { properties[key] = value; } }) },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: name => sheets.get(name) || null,
        insertSheet: name => { const sheet = makeSheet(name); sheets.set(name, sheet); return sheet; }
      }),
      newRichTextValue: () => ({ setText(text) { return { build: () => ({ text }) }; } }), flush: () => { flushes++; }
    },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (!available) return false; assert.equal(locked, false); locked = true; return true; }, releaseLock: () => { locked = false; } }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (algorithm, value) => [...createHash(algorithm).update(value).digest()] }
  };
  vm.createContext(context);
  if (withMail) vm.runInContext(mailSource, context);
  if (withBeacon) vm.runInContext(beaconSource, context);
  return {
    c: context, sheets, properties,
    get flushes() { return flushes; }, get locked() { return locked; },
    busy: () => { available = false; }, silent: () => { silent = true; },
    beaconRows: () => sheets.get('fleet-beacon')?.rows || []
  };
}
const beacon = (overrides = {}) => ({ label: 'kim-PC', account: 'orgiast.jp', steps: [{ id: 'a', status: 'ok' }], failing: [], pollAt: '2026-10-11T00:00:00Z', ...overrides });

test('beacon: creates fixed header sheet and upserts by label without growing rows', () => {
  const h = harness();
  const first = h.c.upsertFleetBeacon(beacon());
  assert.equal(first.ok, true); assert.equal(first.beacon.label, 'kim-PC');
  assert.equal(JSON.stringify(h.beaconRows()[0]), JSON.stringify(['label', 'account', 'reportedAt', 'steps', 'failing', 'pollAt', 'serverPollAt']));
  assert.equal(h.beaconRows().length, 2);
  h.c.upsertFleetBeacon(beacon({ account: 'other.jp' }));
  assert.equal(h.beaconRows().length, 2);
  assert.equal(h.beaconRows()[1][1], 'other.jp');
  h.c.upsertFleetBeacon(beacon({ label: 'nishi-PC' }));
  assert.equal(h.beaconRows().length, 3);
});

test('beacon: steps beginning with = stay literal strings', () => {
  const h = harness();
  h.c.upsertFleetBeacon(beacon({ steps: '=IMPORTXML("http://x")' }));
  assert.equal(h.beaconRows()[1][3], '=IMPORTXML("http://x")');
});

test('beacon: steps are truncated to 6000 chars and failing arrays join with commas', () => {
  const h = harness();
  h.c.upsertFleetBeacon(beacon({ steps: 'x'.repeat(7000), failing: ['a', 'b', 'c'] }));
  assert.equal(h.beaconRows()[1][3].length, 6000);
  assert.equal(h.beaconRows()[1][4], 'a,b,c');
});

test('beacon: missing or over-long label throws invalid_label', () => {
  assert.throws(() => harness().c.upsertFleetBeacon(beacon({ label: '' })), /invalid_label/);
  assert.throws(() => harness().c.upsertFleetBeacon(beacon({ label: 'x'.repeat(129) })), /invalid_label/);
  assert.throws(() => harness().c.upsertFleetBeacon({ account: 'a' }), /invalid_label/);
});

test('beacon: lock contention returns busy', () => {
  const h = harness(); h.busy();
  assert.equal(h.c.upsertFleetBeacon(beacon()).error, 'busy');
  assert.equal(h.c.listFleetBeacons().error, 'busy');
});

test('beacon: read-back mismatch throws and releases the lock', () => {
  const h = harness(); h.silent();
  assert.throws(() => h.c.upsertFleetBeacon(beacon()), /read-back/);
  assert.equal(h.locked, false);
});

test('beacon: real poll records FLEET_LAST_POLL, dry-run does not', () => {
  const h = harness();
  h.c.sendFleetMail({ id: 'mail-1', from: 'a', to: 'kim-PC', messageKind: 'note', body: 'b', why: 'w' });
  h.c.pollFleetMail({ to: 'kim-PC', hostname: 'h', dryRun: true });
  assert.equal(h.properties.FLEET_LAST_POLL, undefined);
  h.c.pollFleetMail({ to: 'kim-PC', hostname: 'h' });
  assert.deepEqual(Object.keys(JSON.parse(h.properties.FLEET_LAST_POLL)), ['kim-PC']);
});

test('beacon: FLEET_LAST_POLL stays under 9000 chars with more than 15 PCs', () => {
  const h = harness();
  for (let i = 0; i < 40; i++) h.c.pollFleetMail({ to: `pc-${i}-${'x'.repeat(100)}`, hostname: 'h' });
  const raw = h.properties.FLEET_LAST_POLL;
  assert.ok(raw.length < 9000, `length=${raw.length}`);
  assert.ok(Object.keys(JSON.parse(raw)).length >= 1);
});

test('beacon: listFleetBeacons returns serverPolls and overrides serverPollAt', () => {
  const h = harness();
  h.c.upsertFleetBeacon(beacon({ label: 'kim-PC', pollAt: '2026-10-01T00:00:00Z' }));
  h.c.pollFleetMail({ to: 'kim-PC', hostname: 'h' });
  const listed = h.c.listFleetBeacons();
  assert.equal(listed.ok, true);
  assert.equal(listed.beacons.length, 1);
  assert.equal(listed.beacons[0].pollAt, '2026-10-01T00:00:00Z');
  assert.equal(listed.beacons[0].serverPollAt, listed.serverPolls['kim-PC']);
  assert.ok(listed.serverPolls['kim-PC']);
});

test('beacon: listFleetBeacons tolerates a corrupt FLEET_LAST_POLL', () => {
  const h = harness();
  h.c.upsertFleetBeacon(beacon());
  h.properties.FLEET_LAST_POLL = '{broken';
  const listed = h.c.listFleetBeacons();
  assert.equal(JSON.stringify(listed.serverPolls), '{}');
  assert.equal(listed.beacons[0].serverPollAt, '');
});

test('beacon: Beacon.gs loads standalone without Mail.gs', () => {
  const h = harness({ withMail: false });
  assert.equal(h.c.upsertFleetBeacon(beacon()).ok, true);
  assert.equal(h.c.listFleetBeacons().beacons.length, 1);
});

test('beacon: WebApp authenticates before dispatch and routes beacon kinds', () => {
  const h = harness();
  for (const match of webSource.matchAll(/(?:'[^']+'|\w+): (\w+),?\n/g)) if (!h.c[match[1]]) h.c[match[1]] = () => ({ ok: true });
  h.c.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => JSON.parse(value) }) };
  vm.runInContext(webSource, h.c);
  h.c.upsertFleetStatus = () => ({ ok: true, legacy: true });
  const post = p => h.c.doPost({ postData: { contents: JSON.stringify(p) } });
  assert.equal(post({ kind: 'fleet-beacon', ...beacon(), token: 'wrong' }).status, 401);
  assert.equal(post({ kind: 'fleet-beacon', ...beacon(), token: 'sheet-id' }).beacon.label, 'kim-PC');
  const listed = post({ kind: 'fleet-beacon-list', token: 'sheet-id' });
  assert.equal(listed.ok, true);
  assert.equal(listed.beacons.length, 1);
});
