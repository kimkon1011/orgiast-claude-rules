import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const source = fs.readFileSync(new URL('../gas/fleet-status-sheet/Mail.gs', import.meta.url), 'utf8');
const now = Date.parse('2026-10-14T00:00:00Z');
function harness() {
  const rows = [], properties = { SHEET_ID: 'fixture' };
  const sheet = {
    getLastRow: () => rows.length, setFrozenRows() {}, deleteRow: n => rows.splice(n - 1, 1),
    getRange(row, col, count, width) { return {
      getValues: () => Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => rows[row - 1 + i]?.[col - 1 + j] ?? '')),
      setRichTextValues(values) { values.forEach((values, i) => { rows[row - 1 + i] ??= []; values.forEach((v, j) => { rows[row - 1 + i][col - 1 + j] = v.text; }); }); }
    }; }
  };
  const deps = {
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }), flush() {}, newRichTextValue: () => ({ setText: text => ({ build: () => ({ text }) }) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key], setProperty: (key, value) => { properties[key] = value; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (algorithm, value) => [...createHash(algorithm).update(value).digest()] },
    Date: class extends Date { static now() { return now; } }
  };
  const names = [...source.matchAll(/^function (\w+)\(/gm)].map(m => m[1]);
  const api = new Function(...Object.keys(deps), `${source}\nreturn { ${names.join(', ')}, headers: FLEET_MAIL_HEADERS_ };`)(...Object.values(deps));
  return { ...api, rows, properties };
}
const send = (h, overrides = {}) => h.sendFleetMail({ id: 'mail-original', from: 'sender', to: 'receiver', messageKind: 'note', why: 'test', body: 'body', ...overrides });
const poll = (h, overrides = {}) => h.pollFleetMail({ to: 'receiver', hostname: 'host', ...overrides });
const get = h => h.getFleetMail({ id: 'mail-original' }).mail;

test('v2 migrates a legacy header and preserves historical cells and empty new fields', () => {
  const h = harness(); send(h);
  const boundary = h.headers.indexOf('seenAt');
  h.rows[0] = h.headers.slice(0, boundary); h.rows[1] = h.rows[1].slice(0, boundary);
  const before = [...h.rows[1]];
  const mail = get(h);
  assert.deepEqual(h.rows[0], h.headers);
  assert.deepEqual(h.rows[1], before);
  for (const field of h.headers.slice(boundary)) assert.equal(mail[field], '');
  h.rows[0][1] = 'wrong'; assert.throws(() => get(h), /header mismatch/);
});
test('seen/ack/fail are idempotent, preserve timestamps and never regress terminal status', () => {
  for (const action of ['ackFleetMail', 'failFleetMail']) {
    const h = harness(); send(h); poll(h);
    h.seenFleetMail({ id: 'mail-original', seenBy: 'headless' });
    const seen = get(h);
    assert.equal(seen.status, 'seen'); assert.equal(seen.seenBy, 'headless'); assert.ok(seen.deliveredAt); assert.ok(seen.seenAt);
    h.seenFleetMail({ id: 'mail-original', seenBy: 'other-session' }); assert.deepEqual(get(h), seen);
    h[action]({ id: 'mail-original', reason: 'invalid incoming mail' });
    const terminal = get(h);
    for (const next of ['seenFleetMail', 'ackFleetMail', 'failFleetMail']) {
      assert.equal(h[next]({ id: 'mail-original', seenBy: 'late', reason: 'late' }).ok, true);
      assert.deepEqual(get(h), terminal);
    }
    assert.ok(action === 'ackFleetMail' ? terminal.ackAt : terminal.failedAt);
  }
});
test('expiration failure records reason and old replay cannot regress seen/done/failed/expired', () => {
  for (const action of ['seenFleetMail', 'ackFleetMail', 'failFleetMail']) {
    const h = harness(); send(h); poll(h, { requestId: 'retry' });
    h[action]({ id: 'mail-original', seenBy: 'headless', reason: 'expired' });
    const before = get(h); poll(h, { requestId: 'retry' }); assert.deepEqual(get(h), before);
    if (action === 'failFleetMail') { assert.equal(before.status, 'expired'); assert.equal(before.failReason, 'expired'); }
  }
});
test('new metadata is persisted; urgency recognizes why anywhere and body prefix', () => {
  for (const overrides of [{ why: '件名 [判断依頼] 詳細' }, { body: ' \n[作業依頼] 作業' }, { priority: 'urgent' }]) {
    const h = harness(); send(h, { ...overrides, auto: true, hop: 1 });
    assert.equal(get(h).priority, 'urgent'); assert.equal(get(h).auto, 'true'); assert.equal(get(h).hop, '1');
  }
  const h = harness(); send(h); assert.equal(get(h).auto, 'false'); assert.equal(get(h).hop, '0');
  assert.equal(send(h).duplicate, true);
  assert.throws(() => send(h, { id: 'mail-invalid-hop', hop: -1 }), /hop/);
});
test('exact label/hostname matches take precedence; legacy partial is only a zero-exact fallback', () => {
  const h = harness(); send(h, { to: 'rece' }); send(h, { id: 'mail-exact', to: 'receiver' }); send(h, { id: 'mail-host', to: 'host' });
  assert.deepEqual(poll(h).messages.map(m => m.id), ['mail-exact', 'mail-host']);
  assert.deepEqual(poll(h).messages.map(m => m.id), ['mail-original']);
  assert.deepEqual(poll(h).messages, []);
});
test('auto reply loops and prospective hop >=3 are refused without writes; human replies use parent hop', () => {
  const h = harness(); send(h, { auto: true, hop: 1 });
  const before = JSON.stringify(h.rows);
  assert.deepEqual(h.replyFleetMail({ id: 'mail-original', from: 'receiver', auto: true, resultBody: 'auto' }), { ok: false, reason: 'loop' });
  assert.equal(JSON.stringify(h.rows), before);
  const first = h.replyFleetMail({ id: 'mail-original', from: 'receiver', auto: false, hop: 0, resultBody: 'human' });
  assert.equal(first.reply.hop, 2);
  assert.deepEqual(h.replyFleetMail({ id: first.reply.id, from: 'sender', auto: false, resultBody: 'human' }), { ok: false, reason: 'loop' });
  const again = h.replyFleetMail({ id: 'mail-original', from: 'receiver', auto: false, resultBody: 'changed' });
  assert.equal(again.duplicate, true); assert.equal(again.reply.id, first.reply.id); assert.equal(again.reply.body, first.reply.body);
  assert.equal(h.rows.length, 3);
});
test('decision receipt via mail-send preserves the original pending state and reply linkage', () => {
  const h = harness(); send(h, { why: '[判断依頼] 方針' }); poll(h);
  send(h, { id: 'mail-reply-ack-test', from: 'receiver', to: 'sender', replyTo: 'mail-original', auto: true, hop: 1 });
  assert.equal(get(h).status, 'delivered');
  assert.equal(h.getFleetMail({ id: 'mail-reply-ack-test' }).mail.replyTo, 'mail-original');
});
test('WebApp exposes authenticated status and transition routes', () => {
  const h = harness(); send(h);
  const web = fs.readFileSync(new URL('../gas/fleet-status-sheet/WebApp.gs', import.meta.url), 'utf8');
  const handlerNames = [...new Set([...web.matchAll(/(?:'[^']+'|\w+): (\w+),?\r?\n/g)].map(m => m[1]))];
  const deps = Object.fromEntries(handlerNames.map(name => [name, h[name] || (() => ({ ok: true }))]));
  deps.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'test' }) };
  deps.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => JSON.parse(value) }) };
  const post = new Function(...Object.keys(deps), `${web}\nreturn doPost;`)(...Object.values(deps));
  for (const kind of ['mail-seen', 'mail-ack', 'mail-fail', 'mail-sent-status']) {
    const call = token => post({ postData: { contents: JSON.stringify({ token, kind, id: 'mail-original' }) } });
    assert.equal(call('bad').status, 401); assert.equal(call('test').ok, true); assert.ok(call('test').mail);
  }
});
test('one receiver marking a broadcast seen does not consume other receivers delivery', () => {
  const h = harness(); send(h, { to: 'all' }); poll(h);
  h.seenFleetMail({ id: 'mail-original', seenBy: 'headless' });
  assert.equal(poll(h, { to: 'another-receiver', hostname: 'another-host' }).messages.length, 1);
  assert.equal(poll(h, { processedIds: ['mail-original'] }).messages.length, 0);
});
test('retry after an appended reply but uncommitted original repairs completion without another reply', () => {
  const h = harness(); send(h); poll(h);
  const before = [...h.rows[1]];
  const reply = h.replyFleetMail({ id: 'mail-original', from: 'receiver', resultBody: 'persisted answer' }).reply;
  h.rows[1] = before; // Simulate original-row write failure after the reply append.
  const result = h.replyFleetMail({ id: 'mail-original', from: 'receiver', resultBody: 'different retry body' });
  assert.equal(result.duplicate, true); assert.equal(h.rows.length, 3); assert.equal(get(h).status, 'done'); assert.equal(get(h).resultBody, reply.body);
});
