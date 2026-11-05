import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { normalizeSubject, isReply, isExcluded, elapsedDays, findWaiting, decodeHeader, decodeBody, parseOptions, ImapReader, formatDate, messageFromHeaders } from './outbound-reply-chase.mjs';

const sent = { app: 'Yahoo! メール', account: 'me@example.com', folder: 'Sent', date: '2026-10-10T00:00:00Z', to: 'Person <person@example.com>', subject: '相談　見積', messageId: '<sent@example.com>' };
const incoming = { date: '2026-10-13T00:00:00Z', from: 'Person <PERSON@example.com>', subject: 'Re: 相談 見積' };
const now = Date.parse('2026-11-04T00:00:00Z');
test('subject prefixes and full-width spaces normalize, original subject remains intact', () => {
  for (const prefix of ['Re:', 'RE:', 'Fwd:', 'FW:', ' Re:　FW: RE: ']) assert.equal(normalizeSubject(`${prefix}相談　見積`), '相談 見積');
  assert.equal(normalizeSubject('Report: RE: test'), 'Report: RE: test');
  assert.equal(sent.subject, '相談　見積');
});
test('In-Reply-To or References matches even with changed subject', () => {
  assert.ok(isReply(sent, { ...incoming, subject: '別件名', inReplyTo: sent.messageId }, 'person@example.com'));
  assert.ok(isReply(sent, { ...incoming, subject: '', references: `<other@example.com> ${sent.messageId}` }, 'person@example.com'));
  assert.equal(isReply(sent, { ...incoming, subject: '', inReplyTo: '<sent@example.com.invalid>' }, 'person@example.com'), false);
});
test('same sender, normalized subject and later date match', () => assert.ok(isReply(sent, incoming, 'person@example.com')));
test('earlier, equal, invalid dates, different sender and different subject do not match', () => {
  for (const change of [{ date: '2026-10-09T00:00:00Z' }, { date: sent.date }, { date: 'invalid' }, { from: 'other@example.com' }]) {
    assert.equal(isReply(sent, { ...incoming, inReplyTo: sent.messageId, ...change }, 'person@example.com'), false);
  }
  assert.equal(isReply(sent, { ...incoming, subject: '別件名' }, 'person@example.com'), false);
});
test('automated recipients and list/automatic headers excluded', () => {
  for (const address of ['noreply@example.com', 'NO-REPLY@example.com', 'notification@example.com', 'mailer-daemon@example.com']) assert.ok(isExcluded(sent, address));
  assert.equal(isExcluded(sent, 'person@example.com'), false);
  assert.ok(isExcluded({ ...sent, listUnsubscribe: '<https://example.com>' }, 'person@example.com'));
  assert.ok(isExcluded({ ...sent, autoSubmitted: 'auto-generated' }, 'person@example.com'));
  assert.equal(findWaiting([{ ...sent, to: 'noreply@example.com' }], [], { now }).length, 0);
});
test('whole elapsed days and exact stale threshold', () => {
  assert.equal(elapsedDays('2026-10-28T00:00:01Z', now), 6);
  assert.equal(elapsedDays('2026-10-28T00:00:00Z', now), 7);
  assert.equal(findWaiting([{ ...sent, date: '2026-10-28T00:00:01Z' }], [], { now, staleDays: 7 }).length, 0);
  assert.equal(findWaiting([{ ...sent, date: '2026-10-28T00:00:00Z' }], [], { now, staleDays: 7 }).length, 1);
  assert.equal(findWaiting([{ ...sent, date: 'invalid' }], [], { now }).length, 0);
});
test('reply removes only the corresponding recipient; output has all navigation fields', () => {
  assert.equal(findWaiting([sent], [incoming], { now }).length, 0);
  const result = findWaiting([{ ...sent, cc: 'second@example.com, me@example.com' }], [incoming], { now });
  assert.deepEqual(result, [{ app: sent.app, account: 'm***@example.com', folder: sent.folder, recipient: 'second@example.com', date: sent.date, subject: sent.subject, elapsedDays: 25 }]);
  assert.equal(formatDate(sent.date), '2026-10-10 09:00');
});
test('encoded-word UTF-8 B/Q and ISO-2022-JP', () => {
  assert.equal(decodeHeader('=?UTF-8?B?55u46KuH?= =?UTF-8?Q?_=E8=A6=8B=E7=A9=8D?='), '相談 見積');
  assert.equal(decodeHeader('=?ISO-2022-JP?B?GyRCRnxLXBsoQg==?='), '日本');
});
test('MIME bodies: base64, quoted-printable, ISO-2022-JP and multipart', () => {
  assert.equal(decodeBody('Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n55u46KuH'), '相談');
  assert.equal(decodeBody('Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n=E7=9B=B8=\r\n=E8=AB=87'), '相談');
  assert.equal(decodeBody('Content-Type: text/plain; charset=ISO-2022-JP\r\nContent-Transfer-Encoding: base64\r\n\r\nGyRCRnxLXBsoQg=='), '日本');
  assert.match(decodeBody('Content-Type: multipart/mixed; boundary="part"\r\n\r\n--part\r\nContent-Type: text/plain\r\n\r\nhello\r\n--part--\r\n'), /hello/);
});
test('CLI validates all flags', () => {
  assert.deepEqual(parseOptions([]), { staleDays: 7, daysBack: 180, json: false, skipGmail: false, skipYahoo: false });
  assert.deepEqual(parseOptions(['--stale-days', '0', '--days-back', '60', '--json', '--skip-gmail', '--skip-yahoo']), { staleDays: 0, daysBack: 60, json: true, skipGmail: true, skipYahoo: true });
  for (const args of [['--days-back'], ['--stale-days', '-1'], ['--days-back', '0'], ['--days-back', 'NaN'], ['--wat']]) assert.throws(() => parseOptions(args));
});
test('IMAP byte framing survives fragmented UTF-8 literals and fake tagged lines', async () => {
  const socket = new EventEmitter(); socket.setTimeout = () => {};
  const payload = Buffer.from('Subject: 日本語\r\nC1 OK fake\r\n');
  socket.write = command => {
    assert.equal(command, 'C1 UID FETCH 1 (BODY.PEEK[HEADER])\r\n');
    const wire = Buffer.concat([Buffer.from(`* 1 FETCH (BODY[HEADER] {${payload.length}}\r\n`), payload, Buffer.from(')\r\nC1 OK done\r\n')]);
    setImmediate(() => { for (const byte of wire) socket.emit('data', Buffer.from([byte])); });
  };
  const client = new ImapReader(socket);
  const response = await client.command('UID FETCH 1 (BODY.PEEK[HEADER])');
  assert.deepEqual(response.literals, [payload]);
});
test('IMAP failures never include raw server messages', async () => {
  const socket = new EventEmitter(); socket.setTimeout = () => {};
  socket.write = () => setImmediate(() => socket.emit('data', Buffer.from('C1 NO sensitive-server-response\r\n')));
  await assert.rejects(new ImapReader(socket).command('EXAMINE "Sent"'), error => !error.message.includes('sensitive'));
});

test('missing or malformed Date falls back to IMAP INTERNALDATE', () => {
  const fallback = '2026-10-10T00:00:00.000Z';
  assert.equal(messageFromHeaders({}, {}, fallback).date, fallback);
  assert.equal(messageFromHeaders({ date: 'invalid' }, {}, fallback).date, fallback);
  assert.equal(messageFromHeaders({ date: 'Tue, 13 Oct 2026 09:00:00 +0900' }, {}, fallback).date, '2026-10-13T00:00:00.000Z');
});

import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { main, findManualWaiting, manualSlug, manualLedgerPath } from './outbound-reply-chase.mjs';

function fixture(t) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'reply-waiting-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, '.claude', 'reply-waiting.json');
  const cli = (...args) => spawnSync(process.execPath, [fileURLToPath(new URL('./outbound-reply-chase.mjs', import.meta.url)), ...args], {
    env: { ...process.env, ORGIAST_HOME: home }, encoding: 'utf8', timeout: 10000,
  });
  const add = (...args) => cli('--add', '--who', 'Nichiei Kurosaki', '--channel', 'LINE', '--sent', '2026-11-04', '--subject', '再見積の依頼', ...args);
  return { home, file, cli, add, ledger: () => JSON.parse(readFileSync(file, 'utf8')) };
}
const manual = { id: 'test-20261104', who: '相手', channel: '電話', sentAt: '2026-11-04', subject: '見積', note: '折返し待ち', status: 'waiting' };

test('manual CLI adds slug/date IDs and unique suffixes, retaining explicit and omitted thresholds', t => {
  const f = fixture(t);
  assert.equal(f.add('--stale-days', '5').status, 0);
  assert.equal(f.add().status, 0);
  const [a, b] = f.ledger().entries;
  assert.equal(a.id, 'nichiei-kurosaki-20261104');
  assert.equal(b.id, 'nichiei-kurosaki-20261104-2');
  assert.equal(a.staleDays, 5);
  assert.equal(Object.hasOwn(b, 'staleDays'), false);
  assert.equal(a.status, 'waiting');
  assert.equal(manualSlug('日栄工業 黒崎直人'), 'nichiei-kogyo-kurosaki-naoto');
  assert.equal(manualSlug('山田', 'やまだ'), 'yamada');
  assert.equal(manualSlug('クロサキ ナオト'), 'kurosaki-naoto');
  assert.throws(() => manualSlug('未知の漢字'));
});
test('manual CLI lists fresh entries with every locator and note, then done hides the entry', t => {
  const f = fixture(t);
  assert.equal(f.add('--note', '確認する', '--stale-days', '999999').status, 0);
  const listed = f.cli('--list-manual');
  assert.equal(listed.status, 1, listed.stderr);
  for (const value of ['LINE', 'Nichiei Kurosaki', '再見積の依頼', '2026-11-04', '経過:', '日', 'メモ: 確認する']) assert.ok(listed.stdout.includes(value));
  assert.equal(f.cli('--skip-gmail', '--skip-yahoo').status, 0);
  assert.equal(f.cli('--done', f.ledger().entries[0].id).status, 0);
  assert.equal(f.ledger().entries[0].status, 'done');
  const done = f.cli('--list-manual', '--json');
  assert.equal(done.status, 0);
  assert.deepEqual(JSON.parse(done.stdout).waiting, []);
  assert.equal(f.cli('--done', 'unknown').status, 2);
});
test('manual threshold uses Tokyo calendar days, entry override, CLI fallback, and excludes done', () => {
  const time = Date.parse('2026-11-08T15:00:00Z'); // Nov 9 in Tokyo, exactly 5 days.
  assert.equal(findManualWaiting([manual], { now: time, staleDays: 6 }).length, 0);
  assert.equal(findManualWaiting([manual], { now: time, staleDays: 5 })[0].elapsedDays, 5);
  assert.equal(findManualWaiting([{ ...manual, staleDays: 5 }], { now: time, staleDays: 7 }).length, 1);
  assert.equal(findManualWaiting([{ ...manual, staleDays: 5 }], { now: time - 1, staleDays: 0 }).length, 0);
  assert.equal(findManualWaiting([{ ...manual, status: 'done' }], { now: time, includeFresh: true }).length, 0);
});
async function capture(args, scans) {
  const log = console.log, error = console.error, exitCode = process.exitCode;
  const output = [], warnings = [];
  console.log = value => output.push(value); console.error = value => warnings.push(value);
  try {
    await main(args, { now: Date.parse('2026-11-09T00:00:00Z'), scans });
    return { output: output.join('\n'), warnings, status: process.exitCode };
  } finally { console.log = log; console.error = error; process.exitCode = exitCode; }
}
test('missing and corrupt ledgers still show email results; combined results preserve exit codes', async t => {
  const f = fixture(t);
  const email = findWaiting([sent], [], { now })[0];
  const scans = [['fixture email', false, async () => [email]]];
  const args = ['--ledger', f.file, '--json'];
  let result = await capture(args, scans);
  assert.equal(result.status, 1);
  assert.deepEqual(JSON.parse(result.output).waiting, [email]);
  f.add('--stale-days', '5');
  result = await capture(args, scans);
  assert.equal(result.status, 1);
  const combined = JSON.parse(result.output).waiting;
  assert.equal(combined.length, 2);
  assert.equal(combined.find(item => item.manual).elapsedDays, 5);
  for (const raw of ['{broken', '{"entries":[null]}']) {
    writeFileSync(f.file, raw);
    result = await capture(args, scans);
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.output).waiting, [email]);
    assert.equal(JSON.parse(result.output).warnings.length, 1);
    assert.equal(f.add().status, 2);
    assert.equal(f.cli('--done', 'test').status, 2);
    assert.equal(readFileSync(f.file, 'utf8'), raw);
  }
  rmSync(f.file);
  assert.equal((await capture(args, [])).status, 0);
  assert.equal((await capture(args, [['failed', false, async () => { throw new Error('secret'); }]])).status, 2);
});
test('invalid manual arguments never create a ledger; explicit ledger path overrides home', t => {
  const f = fixture(t);
  for (const args of [['--sent', '2026-02-30'], ['--channel', 'SMS'], ['--subject', ' '], ['--stale-days', '-1'], ['--done', 'x']]) {
    assert.equal(f.add(...args).status, 2);
    assert.equal(existsSync(f.file), false);
  }
  const custom = path.join(f.home, 'custom.json');
  assert.equal(f.add('--ledger', custom).status, 0);
  assert.equal(existsSync(f.file), false);
  assert.equal(JSON.parse(readFileSync(custom, 'utf8')).entries.length, 1);
});
