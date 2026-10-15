import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const read = name => fs.readFileSync(new URL('../gas/fleet-status-sheet/' + name, import.meta.url), 'utf8').replaceAll('\r\n', '\n');
const logicSource = read('InstallBeaconLogic.gs');
const installSource = read('InstallBeacon.gs');
const webSource = read('WebApp.gs');
function harness() {
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
    LockService: { getScriptLock: () => ({ tryLock: () => { if (!available) return false; assert.equal(locked, false); locked = true; return true; }, releaseLock: () => { locked = false; } }) }
  };
  vm.createContext(context);
  vm.runInContext(logicSource, context);
  vm.runInContext(installSource, context);
  for (const match of webSource.matchAll(/(?:'[^']+'|\w+): (\w+),?\n/g)) if (!context[match[1]]) context[match[1]] = () => ({ ok: true });
  context.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => JSON.parse(value) }) };
  vm.runInContext(webSource, context);
  return {
    c: context, sheets, properties,
    get flushes() { return flushes; }, get locked() { return locked; },
    busy: () => { available = false; }, silent: () => { silent = true; },
  };
}
const beacon = (extra = {}) => ({ kind: 'install-beacon', hostname: '作業用011', os: 'darwin 24.1.0', installer: 'sh-1', ...extra });
const post = (h, p, padding = '') => h.c.doPost({ postData: { contents: JSON.stringify(p) + padding } });

test('validation: Japanese hostname, optional fields, fixed allowlist and exact size boundary', () => {
  const c = harness().c;
  const result = c.installBeaconValidate(beacon({ token: 'discard', arbitrary: 'discard' }), 2048);
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.value), ['hostname', 'os', 'claudeAccount', 'serial', 'installer']);
  assert.equal(result.value.serial, '');
  assert.equal(c.installBeaconValidate(beacon(), 2049).status, 413);
});
for (const [field, valid, invalid] of [
  ['hostname', ['a', '作業用011', 'a'.repeat(64), 'A._ -'], ['', 'a'.repeat(65), '-pc', '=pc', 'a\nb', '@pc', null, 1]],
  ['os', ['a', 'a'.repeat(64), 'win32 10.0.26200'], ['', 'a'.repeat(65), '日本語', 'a\nb', null]],
  ['claudeAccount', ['', 'a@b.co', 'a'.repeat(123) + '@b.co', '=a@b.co'], ['a'.repeat(124) + '@b.co', 'a@b', 'a b@c.co', null, 1]],
  ['serial', ['', 'ABCDE', 'A'.repeat(20)], ['ABCD', 'A'.repeat(21), 'ABCDE-', null]],
  ['installer', ['sh-1', 'ps1-' + 'a'.repeat(32)], ['', 'sh-', 'sh-' + 'a'.repeat(33), 'exe-1', null]],
]) test('validation boundaries: ' + field, () => {
  const c = harness().c;
  for (const value of valid) assert.equal(c.installBeaconValidate(beacon({ [field]: value }), 100).ok, true, String(value));
  for (const value of invalid) assert.equal(c.installBeaconValidate(beacon({ [field]: value }), 100).error, 'invalid_' + field, String(value));
  if (['hostname', 'os', 'installer'].includes(field)) {
    const value = beacon(); delete value[field];
    assert.equal(c.installBeaconValidate(value, 100).error, 'invalid_' + field);
  }
});

test('plan: create/update, case-insensitive key, firstSeenAt and count; 500 rows allow updates only', () => {
  const c = harness().c;
  const v = c.installBeaconValidate(beacon({ hostname: 'PC' }), 100).value;
  const first = c.installBeaconPlan([], v, 'first');
  assert.equal(first.action, 'created'); assert.equal(first.row.count, 1);
  const rows = Array.from({ length: 500 }, (_, i) => ({ ...first.row, hostname: i ? 'host-' + i : 'PC' }));
  const next = c.installBeaconPlan(rows, { ...v, hostname: 'pc', os: 'win32' }, 'last');
  assert.equal(next.action, 'updated'); assert.equal(next.row.count, 2);
  assert.equal(next.row.firstSeenAt, 'first'); assert.equal(next.row.lastSeenAt, 'last');
  assert.equal(next.row.hostname, 'PC'); assert.equal(next.row.os, 'win32');
  assert.equal(c.installBeaconPlan(rows, { ...v, hostname: 'new' }, 'last').error, 'full');
  assert.equal(c.installBeaconPlan(rows.slice(1), { ...v, hostname: 'new' }, 'last').action, 'created');
});

test('doPost: only install-beacon bypasses token; original raw length is used', () => {
  const h = harness();
  assert.equal(post(h, beacon()).action, 'created');
  for (const kind of ['install-beacon-list', 'fleet-beacon', 'mail-send', 'unknown', 'liveness']) assert.equal(post(h, { kind }).status, 401);
  assert.equal(post(h, { kind: 'install-beacon-list', token: 'sheet-id' }).rows.length, 1);
  const p = beacon(); const size = JSON.stringify(p).length;
  assert.equal(post(h, p, ' '.repeat(2048 - size)).ok, true);
  assert.equal(post(h, p, ' '.repeat(2049 - size)).status, 413);
  assert.equal(post(h, { kind: 'install-beacon-list', token: 'sheet-id', extra: 'a'.repeat(3000) }).ok, true);
});

test('storage: rich text, read-back, dedicated tab, busy and silent failure', () => {
  const h = harness();
  assert.equal(post(h, beacon({ claudeAccount: '=a@b.co' })).ok, true);
  assert.deepEqual([...h.sheets.keys()], ['install-beacon']);
  assert.equal(h.sheets.get('install-beacon').rows[1][2], '=a@b.co');
  assert.ok(h.flushes >= 2);
  assert.equal(post(h, beacon()).action, 'updated');
  assert.equal(h.c.listInstallBeacons().rows[0].count, 2);
  h.silent(); assert.equal(post(h, beacon()).error, 'storage_failed'); assert.equal(h.locked, false);
  h.busy(); assert.equal(post(h, beacon()).error, 'busy');
});

test('notification: only new rows, mentions disabled, User-Agent, HTTP and thrown failures are nonfatal', () => {
  const h = harness(); let sends = 0;
  h.properties.FLEET_MAIL_DISCORD_WEBHOOK = 'https://example.invalid/mock';
  h.c.UrlFetchApp = { fetch(url, options) {
    sends++; assert.equal(h.locked, false); assert.equal(options.muteHttpExceptions, true);
    assert.match(options.headers['User-Agent'], /DiscordBot/);
    assert.deepEqual(JSON.parse(options.payload).allowed_mentions, { parse: [] });
    if (sends === 2) throw new Error('private service details');
    return { getResponseCode: () => 429 };
  } };
  assert.equal(post(h, beacon()).ok, true);
  assert.equal(post(h, beacon()).ok, true); assert.equal(sends, 1);
  assert.equal(post(h, beacon({ hostname: 'second' })).ok, true); assert.equal(sends, 2);
});

test('storage cap: 500 recorded PCs reject append, allow update without growing tab', () => {
  const h = harness();
  post(h, beacon());
  const rows = h.sheets.get('install-beacon').rows;
  for (let i = 1; i < 500; i++) rows.push(['host-' + i, 'win32', '', '', 'ps1-1', 'first', 'last', '1']);
  assert.equal(post(h, beacon({ hostname: 'new-PC' })).status, 429);
  assert.equal(rows.length, 501);
  assert.equal(post(h, beacon({ hostname: 'HOST-1' })).action, 'updated');
  assert.equal(rows.length, 501);
  assert.equal(h.c.listInstallBeacons().rows[1].count, 2);
});
