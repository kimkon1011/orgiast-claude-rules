import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSelfTest, fixtureEvent, fixtureCandidate } from './daytrip-detect.fixtures.mjs';
import { run, journal, makeBatch, parseReply, dateRange, createGeocoder, createSheetClient, listEvents, reportRow, writeConfirmed, processReplies, deliverOnce, HEADERS, SHEET_HEADERS } from './daytrip-detect.mjs';
import { KIM_DISCORD_USER_ID } from './notify-kim.mjs';
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daytrip-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function setup(t) {
  const dir = temp(t), ledger = journal(path.join(dir, 'ledger.jsonl')), c = fixtureCandidate(), batch = makeBatch([c], []);
  ledger.save(batch); ledger.save({ type: 'dm-sent', id: batch.id, messageId: '100', sentAt: '2026-11-02T01:00:00Z' });
  return { ledger, c, batch };
}
test('offline acceptance fixtures', async () => runSelfTest(() => {}));
test('CLI self-test prints every fixture case and PASS to stdout', () => {
  const result = spawnSync(process.execPath, ['tools/daytrip-detect.mjs', '--self-test'], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.split('\n').filter(line => line.startsWith('ok: ')).length, 10);
  assert.match(result.stdout, /daytrip-detect self-test: PASS \(network-free\)\n$/);
});
test('CLI self-test propagates an assertion failure as exit 1', t => {
  const preload = path.join(temp(t), 'fail-assert.mjs');
  fs.writeFileSync(preload, "import assert from 'node:assert/strict'; assert.equal = () => { throw new Error('injected self-test failure'); };\n");
  const result = spawnSync(process.execPath, ['tools/daytrip-detect.mjs', '--self-test'], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /injected self-test failure/);
  assert.doesNotMatch(result.stdout, /self-test: PASS/);
});
test('inclusive JST date range and invalid args', () => {
  assert.deepEqual(dateRange({ now: Date.parse('2026-11-02T15:01:00Z') }), { from: '2026-10-27', to: '2026-11-09', timeMin: '2026-10-26T15:00:00.000Z', timeMax: '2026-11-09T15:00:00.000Z' });
  for (const from of ['2026-02-30','xxx','2026-13-01']) assert.throws(() => dateRange({ from }));
  assert.throws(() => dateRange({ from: '2026-12-01', to: '2026-11-01' }));
});
test('dry-run never touches Discord, Sheets or ledger', async t => {
  const dir = temp(t); let calls = 0;
  const result = await run({ dryRun: true, stateDir: dir, from: '2026-11-02', to: '2026-11-02' }, { events: [fixtureEvent()], geocode: async () => ({ lat: 35.01, lon: 135.76 }), discord: { channel() { calls++; throw new Error(); } }, sheetsFactory() { calls++; throw new Error(); } });
  assert.equal(calls, 0); assert.equal(result.candidates.length, 1); assert.ok(!fs.existsSync(path.join(dir, 'ledger.jsonl')));
});
test('geocoder throttles, identifies client, caches and re-geocodes LLM municipality', async t => {
  const dir = temp(t), waits = []; let now = 100000, calls = 0, inferred = 0;
  const options = { dir, now: () => now, sleep: async ms => { waits.push(ms); now += ms; }, log() {}, infer: async () => { inferred++; return '京都府京都市'; }, fetchImpl: async (url, init) => {
    assert.match(init.headers['User-Agent'], /OrgiastDaytripDetect/); calls++;
    return Response.json(new URL(url).searchParams.get('q') === '京都府京都市' ? [{ lat: '35', lon: '135.7' }] : []);
  } };
  const geo = createGeocoder(options);
  assert.equal((await geo('不明会場')).approximate, true); await geo('不明会場');
  assert.equal(calls, 2); assert.equal(inferred, 1); assert.ok(waits.includes(15000));
  await createGeocoder(options)('不明会場'); assert.equal(calls, 2);
});
test('calendar paginates and fixes primary/JST', async () => {
  const urls = [];
  const result = await listEvents(dateRange({ from: '2026-11-01', to: '2026-11-02' }), 'fake', async url => {
    urls.push(url); return Response.json(urls.length === 1 ? { items: [1], nextPageToken: 'next' } : { items: [2] });
  });
  assert.deepEqual(result, [1,2]); assert.match(urls[1], /pageToken=next/); assert.match(urls[0], /primary\/events/);
});
test('reply parser rejects ambiguous/conflicting syntax', () => {
  assert.deepEqual(parseReply('はい 1\nいいえ 1'), []); assert.deepEqual(parseReply('はい 1-3'), []);
  assert.deepEqual(parseReply('はい １、３'), [{ number: 1, accepted: true }, { number: 3, accepted: true }]);
});
test('only kim replies sent after the prompt are accepted; replay does not append twice', async t => {
  const { ledger, c } = setup(t); const rows = [HEADERS, ['','（記入例）金']]; let appended = 0, sent = 0;
  const messages = [{ id: '99', author: { id: KIM_DISCORD_USER_ID }, content: 'はい 1' }, { id: '101', author: { id: 'stranger' }, content: 'はい 1' }, { id: '102', author: { id: KIM_DISCORD_USER_ID }, content: 'はい 1' }];
  const discord = { messages: async () => messages, send: async () => { sent++; return { messageId: '103', sentAt: '2026-11-03T12:00:00Z' }; } };
  const factory = async () => ({ rows: async () => rows, append: async row => { appended++; rows.push(row); return 'report!A3:P3'; } });
  await processReplies(ledger, discord, 'channel', factory, Date.parse('2026-11-02T12:00:00Z'));
  assert.equal(appended, 0); // future / same-day approval does not become a completed report
  await processReplies(ledger, discord, 'channel', factory, Date.parse('2026-11-03T12:00:00Z'));
  await processReplies(ledger, discord, 'channel', factory, Date.parse('2026-11-04T12:00:00Z'));
  assert.equal(appended, 1); assert.equal(sent, 1); assert.deepEqual(rows[2], reportRow(c)); assert.equal(rows[1][1], '（記入例）金');
});
test('decline writes ledger without sheets; later decline cancels pre-approval', async t => {
  const { ledger } = setup(t);
  const discord = { messages: async () => [{ id: '101', author: { id: KIM_DISCORD_USER_ID }, content: 'はい 1' }, { id: '102', author: { id: KIM_DISCORD_USER_ID }, content: 'いいえ 1' }] };
  await processReplies(ledger, discord, 'channel', () => { throw new Error('must not access sheet'); }, Date.parse('2026-11-03T12:00:00Z'));
  assert.equal(ledger.rows.filter(r => r.type === 'decision').at(-1).status, 'declined');
});
test('crash after sheet append reconciles, unknown append outcome is never retried', async t => {
  const { ledger, c } = setup(t); const row = reportRow(c);
  ledger.save({ type: 'append-intent', date: c.date, row });
  await assert.rejects(writeConfirmed(c, ledger, { rows: async () => [HEADERS, []], append: () => { throw new Error('unsafe'); } }), /uncertain sheet append/);
  await writeConfirmed(c, ledger, { rows: async () => [HEADERS, [], row], append: () => { throw new Error('duplicate'); } });
  assert.equal(ledger.rows.at(-1).type, 'recorded');
});
test('crash after DM reconciles before considering another send', async t => {
  const dir = temp(t), log = journal(path.join(dir, 'ledger.jsonl'));
  log.save({ type: 'dm-intent', id: 'batch', body: 'body' });
  await deliverOnce(log, { messages: async () => [{ id: '1', author: { bot: true }, content: 'body', timestamp: new Date().toISOString() }], send: () => { throw new Error('duplicate'); } }, 'batch', 'body', 'channel');
  assert.equal(log.rows.at(-1).type, 'dm-sent');
});
test('Discord length limit defers entire candidates without losing or clipping text', () => {
  const c = fixtureCandidate(), many = Array.from({ length: 30 }, (_,i) => ({ ...c, date: `2026-11-${String(i+1).padStart(2,'0')}` }));
  const batch = makeBatch(many, []); assert.ok(batch.body.length <= 1950); assert.ok(batch.items.length < many.length);
  const next = makeBatch(many, [batch]); assert.equal(next.items[0].number, batch.items.length + 1);
});
test('sheet finds unique header tab and append uses RAW and INSERT_ROWS', async () => {
  const calls = [];
  const client = createSheetClient('fake', async (url, init) => {
    calls.push({ url, init });
    if (url.includes('?fields=')) return Response.json({ sheets: [{ properties: { title: '報告書' } }] });
    if (url.includes(':append?')) return Response.json({ updates: { updatedRows: 1, updatedRange: "'報告書'!A3:P3" } });
    return Response.json({ values: [SHEET_HEADERS, ['','（記入例）金']] });
  });
  await client.rows(); await client.append(reportRow(fixtureCandidate()));
  const call = calls.at(-1); assert.match(call.url, /valueInputOption=RAW&insertDataOption=INSERT_ROWS/); assert.equal(JSON.parse(call.init.body).values[0].length, 16);
});
test('deployment covers new installs, existing poller and converge with host guard', () => {
  for (const file of ['install-orgiast.ps1','fleet-poller.ps1']) assert.match(fs.readFileSync(new URL(file, import.meta.url), 'utf8'), /register-daytrip-detect-task\.ps1/);
  const ps = fs.readFileSync(new URL('register-daytrip-detect-task.ps1', import.meta.url), 'utf8');
  assert.match(ps, /line-ingest/); assert.match(ps, /20:00/); assert.match(ps, /Get-SyncedRepoRoot/);
  const manifest = JSON.parse(fs.readFileSync(new URL('setup-manifest.json', import.meta.url)));
  const entry = manifest.items.find(e => e.id === 'task:daytrip-detect');
  assert.match(entry.spec.ifPresent, /line-ingest/); assert.deepEqual(entry.repair, ['register-daytrip-detect-task.mjs']);
});
test('converge wrapper explicitly passes Ensure and propagates registration failures', async () => {
  const { main } = await import('./register-daytrip-detect-task.mjs');
  let called;
  assert.equal(main({ platform: 'win32', spawnImpl: (command,args) => { called = { command,args }; return { status: 0, stdout: '' }; } }), 0);
  assert.equal(called.args.at(-1), '-Ensure');
  assert.throws(() => main({ platform: 'win32', spawnImpl: () => ({ status: 1, stderr: 'failed' }) }), /failed/);
});
test('normal rerun never asks a date twice, including declined dates', async t => {
  const dir = temp(t); let sends = 0;
  const discord = { channel: async () => 'channel', send: async () => { sends++; return { messageId: '100', sentAt: '2026-11-02T12:00:00Z', channelId: 'channel' }; }, messages: async () => [{ id: '101', content: 'いいえ 1', author: { id: KIM_DISCORD_USER_ID } }] };
  const options = { stateDir: dir, from: '2026-11-02', to: '2026-11-02' }, deps = { now: Date.parse('2026-11-03T12:00:00Z'), events: [fixtureEvent()], geocode: async () => ({ lat: 35.01, lon: 135.76 }), discord, sheetsFactory: () => { throw new Error('unexpected sheet'); } };
  await run(options, deps); await run(options, deps); await run(options, deps);
  assert.equal(sends, 1);
  const rows = journal(path.join(dir, 'ledger.jsonl')).rows;
  assert.equal(rows.filter(r => r.type === 'batch').length, 1);
  assert.equal(rows.filter(r => r.type === 'decision').at(-1).status, 'declined');
});
test('ledger persists candidate overflow beyond the next calendar window', async t => {
  const dir = temp(t), log = journal(path.join(dir, 'ledger.jsonl')), c = fixtureCandidate();
  log.save({ type: 'queued', candidate: c });
  let body;
  await run({ stateDir: dir, from: '2026-11-20', to: '2026-11-20' }, { events: [], geocode: () => { throw new Error(); }, discord: { channel: async () => 'channel', send: async text => { body = text; return { messageId: '100', sentAt: '2026-11-20T12:00:00Z' }; } } });
  assert.match(body, /2026-11-02/);
});
test('sheet read-back failure retains append intent for recovery', async t => {
  const { ledger, c } = setup(t);
  await assert.rejects(writeConfirmed(c, ledger, { rows: async () => [HEADERS, []], append: async () => 'A3:P3' }), /read-back failed/);
  assert.equal(ledger.rows.at(-1).type, 'append-intent');
});
