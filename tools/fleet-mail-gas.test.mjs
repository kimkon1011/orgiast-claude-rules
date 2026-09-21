import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const source = fs.readFileSync(new URL('../gas/fleet-status-sheet/Mail.gs', import.meta.url), 'utf8');
function harness() {
  const rows = []; let frozen = 0, flushes = 0, locked = false, available = true, silent = false;
  const sheet = {
    getLastRow: () => rows.length, setFrozenRows: n => { frozen = n; }, deleteRow: n => rows.splice(n - 1, 1),
    getRange(row, col, count, width) {
      return { getValues: () => Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => rows[row - 1 + i]?.[col - 1 + j] || '')),
        setRichTextValues(values) { assert.equal(locked, true); if (!silent) values.forEach((v, i) => { rows[row - 1 + i] = v.map(x => x.text); }); } };
    }
  };
  const properties = { SHEET_ID: 'sheet-id', FLEET_TOKEN: 'sheet-id' };
  const context = {
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key] || null, setProperty: (key, value) => { properties[key] = value; } }) },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => rows.length ? sheet : null, insertSheet: () => sheet }),
      newRichTextValue: () => ({ setText(text) { return { build: () => ({ text }) }; } }), flush: () => { flushes++; } },
    LockService: { getScriptLock: () => ({ tryLock: () => { if (!available) return false; assert.equal(locked, false); locked = true; return true; }, releaseLock: () => { locked = false; } }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (algorithm, value) => [...createHash(algorithm).update(value).digest()] }
  };
  vm.createContext(context); vm.runInContext(source, context);
  return { c: context, rows, sheet, get frozen() { return frozen; }, get flushes() { return flushes; }, get locked() { return locked; }, busy: () => { available = false; }, silent: () => { silent = true; } };
}
const send = (overrides = {}) => ({ id: 'mail-1234', from: 'sender-PC', to: 'kim-PC', messageKind: 'note', body: '=IMPORTXML("url")', why: 'test', ...overrides });
const poll = (overrides = {}) => ({ to: 'kim-PC', hostname: 'kim-host', ...overrides });

test('GAS creates fixed header sheet and idempotently appends bounded literal bodies', () => {
  const h = harness(); const a = h.c.sendFleetMail(send());
  assert.equal(a.ok, true); assert.equal(h.frozen, 1); assert.equal(h.rows.length, 2); assert.equal(h.rows[1][5], '=IMPORTXML("url")');
  assert.equal(h.c.sendFleetMail(send()).duplicate, true); assert.equal(h.rows.length, 2);
  h.c.sendFleetMail(send({ id: 'mail-long', body: 'x'.repeat(20001) })); assert.equal(h.rows[2][5].length, 20000); assert.ok(h.flushes >= 3);
});
test('GAS rejects invalid ids, empty targets, kinds and expiry', () => {
  for (const override of [{ id: '../../escape' }, { to: '' }, { messageKind: 'run' }, { expiresAt: 'yesterday' }, { expiresAt: '2000-01-01' }]) assert.throws(() => harness().c.sendFleetMail(send(override)));
});
test('individual poll delivers once, matches label or hostname, dry-run does not consume', () => {
  const h = harness(); h.c.sendFleetMail(send({ to: 'host' }));
  assert.equal(h.c.pollFleetMail(poll({ dryRun: true })).messages.length, 1); assert.equal(h.rows[1][9], 'new');
  const p = h.c.pollFleetMail(poll()); assert.equal(p.messages.length, 1); assert.equal(p.messages[0].status, 'delivered'); assert.equal(p.messages[0].deliveredBy, 'kim-PC');
  assert.equal(h.c.pollFleetMail(poll()).messages.length, 0);
});
test('broadcast replies remain deliverable to another PC; retries append only one reply per PC', () => {
  const h = harness(); h.c.sendFleetMail(send({ to: 'all' }));
  assert.equal(h.c.pollFleetMail(poll()).messages.length, 1); assert.equal(h.rows[1][9], 'new');
  const result = h.c.replyFleetMail({ id: 'mail-1234', from: 'kim-PC', resultBody: 'answer' });
  assert.equal(result.mail.status, 'done'); assert.equal(result.reply.to, 'sender-PC'); assert.equal(result.reply.replyTo, 'mail-1234'); assert.equal(result.reply.kind, 'note');
  h.c.replyFleetMail({ id: 'mail-1234', from: 'kim-PC', resultBody: 'answer' }); assert.equal(h.rows.length, 3);
  assert.equal(h.c.pollFleetMail(poll({ to: 'other-PC', hostname: 'other' })).messages.length, 1);
  assert.equal(h.c.pollFleetMail(poll({ processedIds: ['mail-1234'] })).messages.length, 0);
  h.c.replyFleetMail({ id: 'mail-1234', from: 'other-PC', resultBody: 'other answer' }); assert.equal(h.rows.length, 4);
  assert.equal(h.c.pollFleetMail(poll({ to: 'sender-PC', hostname: 'sender', processedIds: ['mail-1234'] })).messages.length, 2);
  assert.equal(h.c.getFleetMail({ id: 'mail-1234' }).mail.status, 'done');
});
test('expired messages are excluded; prune at most 100 old terminal rows per poll', () => {
  const h = harness(); h.c.sendFleetMail(send());
  const prototype = [...h.rows[1]]; prototype[7] = '2000-01-01T00:00:00Z'; prototype[8] = '2000-01-02T00:00:00Z';
  for (let i = 0; i < 110; i++) { const row = [...prototype]; row[0] = `mail-old-${i}`; row[9] = i % 2 ? 'done' : 'new'; h.rows.push(row); }
  assert.equal(h.c.pollFleetMail(poll()).messages.length, 1); assert.equal(h.rows.length, 12);
  h.c.pollFleetMail(poll()); assert.equal(h.rows.length, 2);
});
test('poll maximum 20 and processed broadcast IDs do not starve new mail', () => {
  const h = harness(); for (let i = 0; i < 21; i++) h.c.sendFleetMail(send({ id: `mail-${i}`, to: 'all' }));
  const first = h.c.pollFleetMail(poll()); assert.equal(first.messages.length, 20);
  assert.equal(h.c.pollFleetMail(poll({ processedIds: first.messages.map(m => m.id) })).messages.length, 1);
});
test('write failures and lock contention cannot report success', () => {
  const h = harness(); h.busy(); assert.equal(h.c.sendFleetMail(send()).error, 'busy');
  const s = harness(); s.c.sendFleetMail(send()); s.silent(); assert.throws(() => s.c.sendFleetMail(send({ id: 'mail-2' })), /read-back/); assert.equal(s.locked, false);
});
test('WebApp authenticates before dispatch and keeps unknown kind status fallback', () => {
  const h = harness();
  const web = fs.readFileSync(new URL('../gas/fleet-status-sheet/WebApp.gs', import.meta.url), 'utf8');
  for (const match of web.matchAll(/(?:'[^']+'|\w+): (\w+),?\n/g)) if (!h.c[match[1]]) h.c[match[1]] = () => ({ ok: true });
  h.c.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => JSON.parse(value) }) };
  vm.runInContext(web, h.c);
  h.c.upsertFleetStatus = () => ({ ok: true, legacy: true });
  const post = p => h.c.doPost({ postData: { contents: JSON.stringify(p) } });
  assert.equal(post({ kind: 'mail-send', ...send(), token: 'wrong' }).status, 401);
  assert.equal(post({ ...send(), kind: 'mail-send', token: 'sheet-id' }).mail.id, 'mail-1234');
  assert.equal(post({ kind: 'unknown', token: 'sheet-id' }).legacy, true);
});

test('lost poll response replays same batch without offering it to a second recipient', () => {
  const h = harness(); h.c.sendFleetMail(send({ to: 'kim' }));
  const batch = poll({ requestId: 'request-1' });
  assert.equal(h.c.pollFleetMail(batch).messages.length, 1);
  assert.equal(h.c.pollFleetMail(poll({ to: 'kim-other', hostname: 'other', requestId: 'request-other' })).messages.length, 0);
  assert.equal(h.c.pollFleetMail(batch).messages.length, 1);
  assert.equal(h.c.pollFleetMail(poll({ requestId: 'request-2' })).messages.length, 0);
});

test('repeated reply chains always have filesystem-safe bounded IDs', () => {
  const h = harness(); let id = h.c.sendFleetMail(send()).mail.id;
  for (let i = 0; i < 20; i++) {
    const result = h.c.replyFleetMail({ id, from: i % 2 ? 'sender-PC' : 'kim-PC', resultBody: 'answer' });
    id = result.reply.id; assert.ok(id.length < 100); assert.match(id, /^mail-[A-Za-z0-9-]+$/);
  }
});
