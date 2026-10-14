import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { TERMINAL_STATUSES } from './fleet-mail.mjs';
const source = fs.readFileSync(new URL('../gas/fleet-status-sheet/Mail.gs', import.meta.url), 'utf8');
const now = Date.parse('2026-10-14T00:00:00Z');
function harness({ beaconRows = [['label'], ['receiver'], ['cr-PC']], statusRows = [['label', 'hostname'], ['receiver', 'host']], statusHeaders, rosterFault = false, sheetsTypes = false } = {}) {
  const rows = [], alertRows = [], properties = { SHEET_ID: 'fixture' };
  let time = now;
  const triggers = [], webhooks = [], warnings = [], faults = {};
  const lock = { held: false, releases: 0, hasLock() { return this.held; }, tryLock() { this.held = true; return true; }, releaseLock() { this.held = false; this.releases++; } };
  const cellValue = value => {
    if (!sheetsTypes || typeof value !== 'string') return value;
    if (/^(true|false)$/i.test(value)) return value.toLowerCase() === 'true';
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
    return value;
  };
  const makeSheet = rows => ({
    maxColumns: 26, getMaxColumns() { return this.maxColumns; }, insertColumnsAfter(_after, count) { this.maxColumns += count; },
    getLastRow: () => rows.length, getLastColumn: () => Math.max(0, ...rows.map(row => row.length)), setFrozenRows() {}, deleteRow: n => rows.splice(n - 1, 1),
    getRange(row, col, count, width) { if (col + width - 1 > this.maxColumns) throw new Error('range exceeds grid'); return {
      getValues: () => {
        if (rows === alertRows && count === 1 && row === faults.readBackRow) return [Array(width).fill('mismatch')];
        return Array.from({ length: count }, (_, i) => Array.from({ length: width }, (_, j) => rows[row - 1 + i]?.[col - 1 + j] ?? '')); },
      setValues(values) {
        values.forEach((values, i) => { rows[row - 1 + i] ??= []; values.forEach((v, j) => { rows[row - 1 + i][col - 1 + j] = cellValue(v); }); });
      },
      setRichTextValues(values) {
        if (rows === alertRows && faults.onAlertWrite) faults.onAlertWrite(row);
        if (rows === alertRows && row === faults.writeRow) throw new Error('private failure');
        this.setValues(values.map(values => values.map(v => v.text))); }
    }; }
  });
  const sheet = makeSheet(rows), alertsSheet = makeSheet(alertRows);
  const deps = {
    ...(statusHeaders ? { FLEET_HEADERS_: statusHeaders, _fleetReadSheet_: () => { if (rosterFault) throw new Error('fixture roster failure'); return makeSheet(statusRows); } } : {}),
    SpreadsheetApp: { openById: () => ({ getSheetByName: name => name === 'fleet-mail' ? sheet : name === 'fleet-mail-alerts' ? alertsSheet : name === 'fleet-beacon' && beaconRows ? makeSheet(beaconRows) : name === 'fleet-status' && statusRows ? makeSheet(statusRows) : null }), flush() {}, newRichTextValue: () => ({ setText: text => ({ build: () => ({ text }) }) }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => properties[key], setProperty: (key, value) => { properties[key] = value; } }) },
    LockService: { getScriptLock: () => lock },
    console: { warn: text => warnings.push(text) },
    Utilities: { DigestAlgorithm: { SHA_256: 'sha256' }, computeDigest: (algorithm, value) => [...createHash(algorithm).update(value).digest()] },
    Date: class extends Date { static now() { return time; } },
    UrlFetchApp: { fetch: (...args) => { webhooks.push(args); return { getResponseCode: () => properties.WEBHOOK_STATUS || 204 }; } },
    ScriptApp: {
      getProjectTriggers: () => [...triggers], deleteTrigger: trigger => triggers.splice(triggers.indexOf(trigger), 1),
      newTrigger: name => ({ timeBased: () => ({ everyMinutes: minutes => ({ create: () => triggers.push({ getHandlerFunction: () => name, getEventType: () => 'CLOCK', getTriggerSource: () => 'CLOCK', minutes }) }) }) }),
    }
  };
  const names = [...source.matchAll(/^function (\w+)\(/gm)].map(m => m[1]);
  const api = new Function(...Object.keys(deps), `${source}\nreturn { ${names.join(', ')}, headers: FLEET_MAIL_HEADERS_, alertHeaders: FLEET_MAIL_ALERT_HEADERS_, renotifyMs: FLEET_MAIL_RENOTIFY_MS_, sla: FLEET_MAIL_SLA_, ackLimit: FLEET_MAIL_ACK_LIMIT_, terminalStatuses: FLEET_MAIL_TERMINAL_STATUSES_, pollLimit: FLEET_MAIL_POLL_LIMIT_ };`)(...Object.values(deps));
  return { ...api, rows, alertRows, properties, triggers, webhooks, faults, warnings, lock, advance: ms => { time += ms; } };
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
    h.seenFleetMail({ from: 'receiver', id: 'mail-original', seenBy: 'headless' });
    const seen = get(h);
    assert.equal(seen.status, 'seen'); assert.equal(seen.seenBy, 'headless'); assert.ok(seen.deliveredAt); assert.ok(seen.seenAt);
    h.seenFleetMail({ from: 'receiver', id: 'mail-original', seenBy: 'other-session' }); assert.deepEqual(get(h), seen);
    h[action]({ from: 'receiver', id: 'mail-original', reason: 'invalid incoming mail' });
    const terminal = get(h);
    for (const next of ['seenFleetMail', 'ackFleetMail', 'failFleetMail']) {
      assert.equal(h[next]({ from: 'receiver', id: 'mail-original', seenBy: 'late', reason: 'late' }).ok, true);
      assert.deepEqual(get(h), terminal);
    }
    assert.ok(action === 'ackFleetMail' ? terminal.ackAt : terminal.failedAt);
  }
});
test('expiration failure records reason and old replay cannot regress seen/done/failed/expired', () => {
  for (const action of ['seenFleetMail', 'ackFleetMail', 'failFleetMail']) {
    const h = harness(); send(h); poll(h, { requestId: 'retry' });
    h[action]({ from: 'receiver', id: 'mail-original', seenBy: 'headless', reason: 'expired' });
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
  assert.notEqual(again.reply.id, first.reply.id); assert.equal(again.reply.body, 'changed');
  assert.equal(h.rows.length, 4);
});
test('decision receipt via mail-send preserves the original pending state and reply linkage', () => {
  const h = harness(); send(h, { why: '[判断依頼] 方針' }); poll(h);
  send(h, { id: 'mail-reply-ack-test', from: 'receiver', to: 'sender', replyTo: 'mail-original', auto: true, hop: 1 });
  assert.equal(get(h).status, 'delivered');
  assert.equal(h.getFleetMail({ id: 'mail-reply-ack-test' }).mail.replyTo, 'mail-original');
});
test('WebApp exposes authenticated status and transition routes', () => {
  const h = harness(); send(h); poll(h);
  const web = fs.readFileSync(new URL('../gas/fleet-status-sheet/WebApp.gs', import.meta.url), 'utf8');
  const handlerNames = [...new Set([...web.matchAll(/(?:'[^']+'|\w+): (\w+),?\r?\n/g)].map(m => m[1]))];
  const deps = Object.fromEntries(handlerNames.map(name => [name, h[name] || (() => ({ ok: true }))]));
  deps.PropertiesService = { getScriptProperties: () => ({ getProperty: () => 'test' }) };
  deps.ContentService = { MimeType: { JSON: 'json' }, createTextOutput: value => ({ setMimeType: () => JSON.parse(value) }) };
  const post = new Function(...Object.keys(deps), `${web}\nreturn doPost;`)(...Object.values(deps));
  for (const kind of ['mail-seen', 'mail-ack', 'mail-fail', 'mail-sent-status']) {
    const call = token => post({ postData: { contents: JSON.stringify({ token, kind, from: 'receiver', id: 'mail-original' }) } });
    assert.equal(call('bad').status, 401); assert.equal(call('test').ok, true); assert.ok(call('test').mail);
  }
});
test('one receiver marking a broadcast seen does not consume other receivers delivery', () => {
  const h = harness(); send(h, { to: 'all' }); poll(h);
  h.seenFleetMail({ from: 'receiver', id: 'mail-original', seenBy: 'headless' });
  assert.equal(poll(h, { to: 'another-receiver', hostname: 'another-host' }).messages.length, 1);
  assert.equal(poll(h, { processedIds: ['mail-original'] }).messages.length, 0);
});
test('retry after an appended reply but uncommitted original repairs completion without another reply', () => {
  const h = harness(); send(h); poll(h);
  const before = [...h.rows[1]];
  const reply = h.replyFleetMail({ id: 'mail-original', from: 'receiver', resultBody: 'persisted answer' }).reply;
  h.rows[1] = before; // Simulate original-row write failure after the reply append.
  const result = h.replyFleetMail({ id: 'mail-original', from: 'receiver', resultBody: 'persisted answer' });
  assert.equal(result.duplicate, true); assert.equal(h.rows.length, 3); assert.equal(get(h).status, 'done'); assert.equal(get(h).resultBody, reply.body);
});

test('D1 sweep expires overdue active states and preserves every terminal state', () => {
  const h = harness(); assert.deepEqual(h.terminalStatuses, TERMINAL_STATUSES);
  const active = ['new', 'delivered', 'seen'];
  for (const status of [...active, ...TERMINAL_STATUSES]) {
    send(h, { id: `mail-${status}` }); h.rows.at(-1)[h.headers.indexOf('status')] = status;
  }
  h.advance(86400000 + 1);
  assert.equal(h.fleetMailSweep().expired, active.length);
  for (const status of [...active, ...TERMINAL_STATUSES]) {
    const stored = h.getFleetMail({ id: `mail-${status}` }).mail.status;
    assert.equal(stored, TERMINAL_STATUSES.includes(status) ? status : 'expired');
  }
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
  poll(h); h.ackFleetMail({ from: 'receiver', id: 'mail-original' }); assert.equal(h.getFleetMailAlerts({}).alerts.length, 0);
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
  const h = harness(); const other = { getHandlerFunction: () => 'processCommandQueue', getEventType: () => 'CLOCK', getTriggerSource: () => 'CLOCK' }; h.triggers.push(other);
  h.setupFleetMailTriggers(); h.setupFleetMailTriggers();
  assert.equal(h.triggers.length, 2); assert.equal(h.triggers[0], other); assert.equal(h.triggers[1].getHandlerFunction(), 'fleetMailSweep'); assert.equal(h.triggers[1].minutes, h.sla.sweepMinutes);
});
test('WebApp exposes authenticated mail-alerts with explicit notification acknowledgement', () => {
  const web = fs.readFileSync(new URL('../gas/fleet-status-sheet/WebApp.gs', import.meta.url), 'utf8');
  assert.match(web, /'mail-alerts': getFleetMailAlerts/);
});

test('C1 changed replies after automatic receipt get distinct ids and retry idempotently', () => {
  const h = harness(); send(h); poll(h);
  const receipt = h.replyFleetMail({ id: 'mail-original', from: 'receiver', auto: true, resultBody: '受領しました' });
  const answer = h.replyFleetMail({ id: 'mail-original', from: 'receiver', resultBody: '本回答' });
  const retry = h.replyFleetMail({ id: 'mail-original', from: 'receiver', resultBody: '本回答' });
  assert.notEqual(receipt.reply.id, answer.reply.id); assert.equal(retry.duplicate, true);
  assert.equal(retry.reply.id, answer.reply.id); assert.equal(get(h).resultBody, '本回答'); assert.equal(h.rows.length, 4);
});
test('C2 batch ack accepts at most the server limit and returns per-id recipient outcomes', () => {
  const h = harness();
  for (let i = 0; i < h.ackLimit; i++) {
    send(h, { id: `mail-batch-${i}` }); h.rows.at(-1)[h.headers.indexOf('deliveredBy')] = 'receiver';
  }
  const ids = h.rows.slice(1).map(row => row[0]);
  const response = h.ackFleetMail({ ids, from: 'receiver' });
  assert.equal(response.results.length, h.ackLimit); assert.ok(response.results.every(r => r.ok && r.mail.status === 'done'));
  assert.throws(() => h.ackFleetMail({ ids: [...ids, 'mail-overflow'], from: 'receiver' }), /invalid_ids/);
  assert.throws(() => h.ackFleetMail({ ids: [ids[0], '../invalid'], from: 'receiver' }), /invalid_id/);
  assert.equal(h.ackFleetMail({ ids: [ids[0]], from: 'other' }).results[0].reason, 'not-recipient');
});
test('C4 broadcasts do not suppress legacy fallback and hostname matching ignores case', () => {
  const h = harness(); send(h, { to: 'all' }); send(h, { id: 'mail-partial', to: 'rece' });
  assert.deepEqual(poll(h).messages.map(m => m.id), ['mail-partial', 'mail-original']);
  send(h, { id: 'mail-host-case', to: 'HOST' });
  assert.ok(poll(h).messages.some(m => m.id === 'mail-host-case'));
});
test('C7 broadcast transitions retain main status and record independent per-PC receipts', () => {
  const h = harness(); send(h, { to: 'all' });
  for (const from of ['receiver', 'other']) {
    h.seenFleetMail({ id: 'mail-original', from });
    h.ackFleetMail({ id: 'mail-original', from });
    h.failFleetMail({ id: 'mail-original', from, reason: 'expired' });
  }
  const before = get(h); assert.equal(before.status, 'new');
  const receipts = JSON.parse(before.receipts); assert.deepEqual(Object.keys(receipts), ['receiver', 'other']);
  for (const receipt of Object.values(receipts)) for (const field of ['seenAt', 'ackAt', 'failedAt']) assert.ok(receipt[field]);
  h.advance(1000); h.seenFleetMail({ id: 'mail-original', from: 'receiver' }); assert.deepEqual(get(h), before);
  assert.equal(poll(h, { to: 'third', hostname: 'third-host' }).messages.length, 1);
});
test('C7 direct transitions reject missing or mismatched recipients even after completion', () => {
  const h = harness(); send(h); poll(h);
  for (const action of ['seenFleetMail', 'ackFleetMail', 'failFleetMail']) {
    const before = get(h);
    for (const from of [undefined, 'other']) assert.deepEqual(h[action]({ id: 'mail-original', from, seenBy: 'receiver' }), { ok: false, reason: 'not-recipient' });
    assert.deepEqual(get(h), before);
  }
  assert.equal(h.ackFleetMail({ id: 'mail-original', from: 'receiver' }).ok, true);
  assert.equal(h.seenFleetMail({ id: 'mail-original', from: 'other' }).reason, 'not-recipient');
});

test('C1 retry repairs changed reply append without regressing to an older receipt', () => {
  const h = harness(); send(h); poll(h);
  h.replyFleetMail({ id: 'mail-original', from: 'receiver', resultBody: 'receipt' });
  const before = [...h.rows[1]];
  const answer = h.replyFleetMail({ id: 'mail-original', from: 'receiver', resultBody: 'answer' });
  h.rows[1] = before;
  const retry = h.replyFleetMail({ id: 'mail-original', from: 'receiver', resultBody: 'answer' });
  assert.equal(retry.duplicate, true); assert.equal(retry.reply.id, answer.reply.id); assert.equal(get(h).resultBody, 'answer');
  h.replyFleetMail({ id: 'mail-original', from: 'receiver', resultBody: 'receipt' });
  assert.equal(get(h).resultBody, 'answer'); assert.equal(h.rows.length, 4);
});

for (const fault of ['writeRow', 'readBackRow']) test(`D2 sweep isolates alert ${fault} failure after completing expiry`, () => {
  const h = harness();
  send(h, { id: 'mail-first' }); send(h, { id: 'mail-later' });
  send(h, { id: 'mail-overdue', expiresAt: new Date(now + 1).toISOString() });
  h.advance(h.sla.undelivered + 1);
  const expiryBeforeAlert = [];
  h.faults.onAlertWrite = () => expiryBeforeAlert.push(h.rows[3][h.headers.indexOf('status')]);
  h.faults[fault] = 2;
  const result = h.fleetMailSweep();
  assert.equal(result.expired, 1); assert.equal(result.alerted, 1);
  assert.ok(expiryBeforeAlert.length); assert.ok(expiryBeforeAlert.every(status => status === 'expired'));
  assert.equal(h.alertRows[2][0], 'mail-later'); assert.equal(h.warnings.length, 1);
  assert.doesNotMatch(h.warnings.join(''), /private|mail-first/);
  delete h.faults[fault]; assert.equal(h.fleetMailSweep().alerted, 2);
});

test('D9 CommandQueue exposes trigger inventory and sweep counts while preserving its parent lock', () => {
  const h = harness();
  const queue = fs.readFileSync(new URL('../gas/fleet-status-sheet/CommandQueue.gs', import.meta.url), 'utf8');
  const names = [...queue.slice(0, queue.indexOf('// PC')).matchAll(/\w+: (\w+)/g)].map(m => m[1]);
  const deps = Object.fromEntries(names.map(name => [name, h[name] || (() => {})]));
  const commands = new Function(...Object.keys(deps), `${queue}\nreturn _COMMANDS_();`)(...Object.values(deps));
  const triggers = commands.setupFleetMailTriggers();
  assert.deepEqual(triggers, [{ handler: 'fleetMailSweep', eventType: 'CLOCK', source: 'CLOCK' }]);
  assert.deepEqual(commands.setupFleetMailTriggers(), triggers);
  send(h); h.advance(h.sla.undelivered + 1);
  h.lock.held = true; const releases = h.lock.releases;
  const result = commands.fleetMailSweep();
  assert.deepEqual({ expired: result.expired, alerted: result.alerted, notified: result.notified }, { expired: 0, alerted: 1, notified: 0 });
  assert.equal(h.lock.held, true); assert.equal(h.lock.releases, releases);
});

test('E GAS appends metadata and execution columns and preserves them through send get and poll', () => {
  const h = harness();
  const meta = { relay: { sessionId: 'session', cwd: 'C:\\作業', questionHash: 'hash', pcLabel: 'receiver' } };
  const sent = send(h, { meta, exec: 'claude', execCwd: meta.relay.cwd, resumeSessionId: 'session', messageKind: 'prompt' });
  assert.equal(sent.mail.meta, JSON.stringify(meta));
  const got = get(h), delivered = poll(h).messages[0];
  for (const m of [got, delivered]) {
    assert.deepEqual(JSON.parse(m.meta), meta); assert.equal(m.exec, 'claude'); assert.equal(m.execCwd, meta.relay.cwd); assert.equal(m.resumeSessionId, 'session');
  }
  assert.ok(h.headers.indexOf('meta') > h.headers.indexOf('receipts'));
});


test('F4 known labels and hostnames never fall through to another PC partial match', () => {
  for (const roster of [
    { beaconRows: [['label'], ['cr-PC']], statusRows: null },
    { beaconRows: null, statusRows: [['label', 'hostname'], ['cr-PC', 'cr-host']] },
  ]) {
    const h = harness(roster); send(h, { to: 'cr-PC' });
    assert.deepEqual(poll(h, { to: '作業用011-cr-PC', hostname: 'another-host' }).messages, []);
    assert.equal(get(h).status, 'new');
    assert.equal(poll(h, { to: 'cr-PC', hostname: 'cr-host' }).messages.length, 1);
  }
  const h = harness(); send(h, { to: 'host' });
  assert.deepEqual(poll(h, { to: 'other', hostname: 'prefix-HOST' }).messages, []);
  assert.equal(poll(h, { hostname: 'HOST' }).messages.length, 1);
});
test('F4 unknown legacy 011 recipient delivers by partial match only with an available roster', () => {
  const h = harness(); send(h, { to: '011' });
  assert.equal(poll(h, { to: '作業用011-cr-PC', hostname: 'other' }).messages.length, 1);
  for (const roster of [
    { beaconRows: null, statusRows: null },
    { beaconRows: [['unexpected']], statusRows: null },
  ]) {
    const closed = harness(roster); send(closed, { to: '011' });
    assert.deepEqual(poll(closed, { to: '作業用011-cr-PC', hostname: 'other' }).messages, []);
    assert.equal(get(closed).status, 'new');
    assert.equal(poll(closed, { to: '011', hostname: 'other' }).messages.length, 1);
  }
});
test('F5 direct recipients precede old broadcasts within the poll limit and receipt replay', () => {
  const h = harness();
  for (let i = 0; i < h.pollLimit; i++) send(h, { id: `mail-broadcast-${i}`, to: 'all' });
  send(h, { id: 'mail-direct' }); send(h, { id: 'mail-host-direct', to: 'host' });
  const batch = poll(h, { requestId: 'priority-batch' }).messages;
  assert.equal(batch.length, h.pollLimit);
  assert.deepEqual(batch.slice(0, 2).map(m => m.id), ['mail-direct', 'mail-host-direct']);
  assert.equal(batch.filter(m => m.to === 'all').length, h.pollLimit - 2);
  assert.deepEqual(poll(h, { requestId: 'priority-batch' }).messages.map(m => m.id), batch.map(m => m.id));
});
test('F6 legacy empty deliveredBy accepts and persists the first claimant across all transitions', () => {
  for (const action of ['seenFleetMail', 'ackFleetMail', 'failFleetMail']) for (const status of ['delivered', 'seen', ...TERMINAL_STATUSES]) {
    const h = harness(); send(h);
    h.rows[1][h.headers.indexOf('status')] = status;
    assert.equal(get(h).deliveredBy, '');
    assert.equal(h[action]({ id: 'mail-original', from: 'legacy-receiver', reason: 'fixture' }).ok, true);
    assert.equal(get(h).deliveredBy, 'legacy-receiver');
    if (TERMINAL_STATUSES.includes(status)) assert.equal(get(h).status, status);
    const before = get(h);
    assert.equal(h[action]({ id: 'mail-original', from: 'other' }).reason, 'not-recipient');
    assert.deepEqual(get(h), before);
  }
});

test('F4 production status headers protect both reporter labels and hostnames and lookup failure closes fallback', () => {
  const statusSource = fs.readFileSync(new URL('../gas/fleet-status-sheet/UpsertLogic.gs', import.meta.url), 'utf8');
  const headers = new Function(`${statusSource}\nreturn FLEET_HEADERS_;`)();
  const roster = { beaconRows: null, statusHeaders: headers,
    statusRows: [[headers.hostname, headers.realHostname], ['cr-PC', 'cr-host']] };
  for (const to of ['cr-PC', 'cr-host']) {
    const h = harness(roster); send(h, { to });
    assert.deepEqual(poll(h, { to: `other-${to}`, hostname: `host-${to}` }).messages, []);
  }
  const broken = harness({ ...roster, rosterFault: true }); send(broken, { to: '011' });
  assert.deepEqual(poll(broken, { to: '作業用011-cr-PC', hostname: 'other' }).messages, []);
});


test('J mail-send succeeds with Sheets boolean and numeric coercion and preserves false/zero on read', () => {
  const h = harness({ sheetsTypes: true });
  for (const auto of [false, true]) {
    const id = `mail-coercion-${auto}`;
    assert.equal(send(h, { id, auto, hop: 0, meta: { relay: true } }).ok, true);
    const row = h.rows.at(-1);
    assert.equal(row[h.headers.indexOf('auto')], auto);
    assert.equal(row[h.headers.indexOf('hop')], 0);
    assert.equal(row[h.headers.indexOf('receipts')], '');
    const mail = h.getFleetMail({ id }).mail;
    assert.equal(mail.auto, String(auto)); assert.equal(mail.hop, '0');
    assert.equal(mail.meta, JSON.stringify({ relay: true }));
    assert.equal(send(h, { id, auto }).duplicate, true);
  }
});
test('J read-back normalizes all cell types without trimming strings or hiding mismatches', () => {
  const h = harness({ sheetsTypes: true });
  const date = new Date(now);
  const values = [true, false, 0, 12, null, undefined, date, { a: 1 }, ' padded ', 'true', 'false', ''];
  const expected = ['true', 'false', '0', '12', '', '', date.toISOString(), JSON.stringify({ a: 1 }), ' padded ', 'true', 'false', ''];
  assert.deepEqual(values.map(h._fleetMailCellText_), expected);
  const row = h.headers.map((_, i) => values[i]);
  let stored;
  const sheet = { getRange: () => ({
    setRichTextValues: cells => { stored = cells[0].map(cell => cell.text); },
    getValues: () => [stored.map((value, i) => i < values.length ? values[i] : value)]
  }) };
  h._fleetMailWrite_(sheet, 1, row);
  assert.deepEqual(stored.slice(0, expected.length), expected);
  sheet.getRange = () => ({ setRichTextValues() {}, getValues: () => [stored.map(value => value === ' padded ' ? value.trim() : value)] });
  assert.throws(() => h._fleetMailWrite_(sheet, 1, row), /read-back mismatch/);
});
