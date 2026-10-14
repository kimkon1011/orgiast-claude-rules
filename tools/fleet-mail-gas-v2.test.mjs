import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
const source = fs.readFileSync(new URL('../gas/fleet-status-sheet/Mail.gs', import.meta.url), 'utf8');
const now = Date.parse('2026-10-14T00:00:00Z');
function harness() {
  const rows = [], alertRows = [], properties = { SHEET_ID: 'fixture' };
  let time = now;
  const triggers = [], webhooks = [];
  const makeSheet = rows => ({
    getLastRow: () => rows.length, setFrozenRows() {}, deleteRow: n => rows.splice(n - 1, 1),
    getRange(row, col, count, width) { return {
      getValues: () => Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => rows[row - 1 + i]?.[col - 1 + j] ?? '')),
      setRichTextValues(values) { values.forEach((values, i) => { rows[row - 1 + i] ??= []; values.forEach((v, j) => { rows[row - 1 + i][col - 1 + j] = v.text; }); }); }
    }; }
  });
  const sheet = makeSheet(rows), alertsSheet = makeSheet(alertRows);
  const deps = {
    SpreadsheetApp: { openById: () => ({ getSheetByName: name => name === 'fleet-mail' ? sheet : alertsSheet }), flush() {}, newRichTextValue: () => ({ setText: text => ({ build: () => ({ text }) }) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key], setProperty: (key, value) => { properties[key] = value; } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (algorithm, value) => [...createHash(algorithm).update(value).digest()] },
    Date: class extends Date { static now() { return time; } },
    UrlFetchApp: { fetch: (...args) => { webhooks.push(args); return { getResponseCode: () => properties.WEBHOOK_STATUS || 204 }; } },
    ScriptApp: {
      getProjectTriggers: () => [...triggers], deleteTrigger: trigger => triggers.splice(triggers.indexOf(trigger), 1),
      newTrigger: name => ({ timeBased: () => ({ everyMinutes: minutes => ({ create: () => triggers.push({ getHandlerFunction: () => name, minutes }) }) }) }),
    }
  };
  const names = [...source.matchAll(/^function (\w+)\(/gm)].map(m => m[1]);
  const api = new Function(...Object.keys(deps), `${source}\nreturn { ${names.join(', ')}, headers: FLEET_MAIL_HEADERS_, alertHeaders: FLEET_MAIL_ALERT_HEADERS_, renotifyMs: FLEET_MAIL_RENOTIFY_MS_, sla: FLEET_MAIL_SLA_ };`)(...Object.values(deps));
  return { ...api, rows, alertRows, properties, triggers, webhooks, advance: ms => { time += ms; } };
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

test('sweep expires all overdue non-done states and preserves completed rows', () => {
  const h = harness();
  for (const status of ['new', 'delivered', 'seen', 'failed', 'done']) {
    send(h, { id: `mail-${status}` }); h.rows.at(-1)[h.headers.indexOf('status')] = status;
  }
  h.advance(86400000 + 1);
  assert.equal(h.fleetMailSweep().expired, 4);
  for (const row of h.rows.slice(1)) assert.equal(row[h.headers.indexOf('status')], row[0] === 'mail-done' ? 'done' : 'expired');
  assert.deepEqual(h.getFleetMailAlerts({}).alerts, []);
});
test('sweep observes strict undelivered and urgent/normal unseen SLA thresholds', () => {
  for (const [status, priority] of [['new', 'normal'], ['delivered', 'urgent'], ['delivered', 'normal']]) {
    const h = harness(); send(h, { priority }); if (status === 'delivered') poll(h);
    h.advance(h.sla[status === 'new' ? 'undelivered' : priority]); assert.equal(h.fleetMailSweep().active, 0);
    h.advance(1); assert.equal(h.fleetMailSweep().active, 1);
    const alerts = h.getFleetMailAlerts({}).alerts;
    assert.equal(alerts.length, 1); assert.equal(alerts[0].kind, status === 'new' ? 'undelivered' : 'unseen'); assert.equal(alerts[0].notifiedCount, 0);
  }
});
test('alert upsert is one row per id; read is not acknowledgement and resolved mail is excluded', () => {
  const h = harness(); send(h); h.advance(h.sla.undelivered + 1); h.fleetMailSweep();
  const first = h.getFleetMailAlerts({}).alerts[0];
  h.advance(600000); h.fleetMailSweep();
  assert.equal(h.alertRows.length, 2); assert.equal(h.getFleetMailAlerts({}).alerts[0].firstAt, first.firstAt);
  assert.equal(h.getFleetMailAlerts({}).alerts.length, 1);
  h.ackFleetMail({ id: 'mail-original' }); assert.equal(h.getFleetMailAlerts({}).alerts.length, 0);
});
test('fallback acknowledgement is idempotent and enables six-hour renotification', () => {
  const h = harness(); send(h); h.advance(h.sla.undelivered + 1); h.fleetMailSweep();
  assert.deepEqual(h.getFleetMailAlerts({ notifiedIds: ['mail-original'] }).alerts, []);
  const before = [...h.alertRows[1]]; h.advance(60000);
  h.getFleetMailAlerts({ notifiedIds: ['mail-original'] }); assert.deepEqual(h.alertRows[1], before);
  h.advance(h.renotifyMs - 60001); assert.equal(h.getFleetMailAlerts({}).alerts.length, 0);
  h.advance(1); h.fleetMailSweep(); assert.equal(h.getFleetMailAlerts({}).alerts[0].notifiedCount, 0);
});
test('server webhook success suppresses watchdog, retries only after six hours', () => {
  const h = harness(); h.properties.FLEET_MAIL_DISCORD_WEBHOOK = 'https://example.invalid/webhook'; send(h); h.advance(h.sla.undelivered + 1);
  assert.equal(h.fleetMailSweep().notified, 1); assert.equal(h.webhooks.length, 1); assert.deepEqual(h.getFleetMailAlerts({}).alerts, []);
  h.fleetMailSweep(); assert.equal(h.webhooks.length, 1);
  h.advance(h.renotifyMs); h.fleetMailSweep(); assert.equal(h.webhooks.length, 2); assert.equal(h.alertRows.length, 2);
});
test('failed webhook leaves pending and alert values are literal/redacted', () => {
  const h = harness(); h.properties.FLEET_MAIL_DISCORD_WEBHOOK = 'https://example.invalid/webhook'; h.properties.WEBHOOK_STATUS = 500;
  send(h, { why: '=formula token=private' }); h.advance(h.sla.undelivered + 1);
  assert.equal(h.fleetMailSweep().notified, 0);
  const alert = h.getFleetMailAlerts({}).alerts[0]; assert.equal(alert.notifiedCount, 0); assert.match(alert.why, /^=formula/); assert.doesNotMatch(alert.why, /private/);
  assert.deepEqual(JSON.parse(h.webhooks[0][1].payload).allowed_mentions, { parse: [] });
});
test('trigger setup is idempotent and preserves other handlers', () => {
  const h = harness(); const other = { getHandlerFunction: () => 'processCommandQueue' }; h.triggers.push(other);
  h.setupFleetMailTriggers(); h.setupFleetMailTriggers();
  assert.equal(h.triggers.length, 2); assert.equal(h.triggers[0], other); assert.equal(h.triggers[1].getHandlerFunction(), 'fleetMailSweep'); assert.equal(h.triggers[1].minutes, h.sla.sweepMinutes);
});
test('WebApp exposes authenticated mail-alerts with explicit notification acknowledgement', () => {
  const web = fs.readFileSync(new URL('../gas/fleet-status-sheet/WebApp.gs', import.meta.url), 'utf8');
  assert.match(web, /'mail-alerts': getFleetMailAlerts/);
});
