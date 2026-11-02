import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runSelfTest, fixtureEvent, fixtureCandidate } from './daytrip-detect.fixtures.mjs';
import { run, journal, makeBatch, parseReply, dateRange, createGeocoder, createSheetClient, listEvents, reportRow, writeConfirmed, answerReply, refreshPending, pendingItems, HEADERS, SHEET_HEADERS } from './daytrip-detect.mjs';
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daytrip-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
function setup(t) {
  const dir = temp(t), ledger = journal(path.join(dir, 'ledger.jsonl')), c = fixtureCandidate(), batch = makeBatch([c], []);
  ledger.save(batch); ledger.save({ type: 'dm-sent', id: batch.id, messageId: '100', sentAt: '2026-11-02T01:00:00Z' });
  refreshPending(dir, ledger);
  return { dir, ledger, c, batch };
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
test('crash after sheet append reconciles, unknown append outcome is never retried', async t => {
  const { ledger, c } = setup(t); const row = reportRow(c);
  ledger.save({ type: 'append-intent', date: c.date, row });
  await assert.rejects(writeConfirmed(c, ledger, { rows: async () => [HEADERS, []], append: () => { throw new Error('unsafe'); } }), /uncertain sheet append/);
  await writeConfirmed(c, ledger, { rows: async () => [HEADERS, [], row], append: () => { throw new Error('duplicate'); } });
  assert.equal(ledger.rows.at(-1).type, 'recorded');
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
test('sheet read-back failure retains append intent for recovery', async t => {
  const { ledger, c } = setup(t);
  await assert.rejects(writeConfirmed(c, ledger, { rows: async () => [HEADERS, []], append: async () => 'A3:P3' }), /read-back failed/);
  assert.equal(ledger.rows.at(-1).type, 'append-intent');
});

function fakeSheets() {
  const rows = [HEADERS, ['', '（記入例）金']]; let reads = 0, appends = 0;
  return { rows, get reads() { return reads; }, get appends() { return appends; },
    factory: async () => ({ rows: async () => { reads++; return rows; }, append: async row => { appends++; rows.push(row); return 'report!A3:P3'; } }) };
}
const now = Date.parse('2026-11-03T12:00:00Z');
test('run without Discord or token publishes only effective unanswered candidates and never reuses numbers', async t => {
  const home = temp(t), dir = path.join(home, '.claude', 'daytrip-detect');
  fs.mkdirSync(dir, { recursive: true });
  const log = journal(path.join(dir, 'ledger.jsonl')), c = fixtureCandidate();
  log.save(makeBatch([{ ...c, date: '2026-10-31' }, { ...c, date: '2026-11-01' }], []));
  log.save({ type: 'decision', date: '2026-11-01', status: 'declined' });
  const options = { home, from: '2026-11-02', to: '2026-11-02' };
  const deps = { now, events: [fixtureEvent()], geocode: async () => ({ lat: 35.01, lon: 135.76 }), sheetsFactory() { throw new Error('unexpected sheets'); } };
  await run(options, deps);
  const pending = JSON.parse(fs.readFileSync(path.join(dir, 'pending.json')));
  assert.deepEqual(pending.items.map(c => [c.number, c.date]), [[3, '2026-11-02']]);
  assert.match(pending.items[0].line, /3\. 2026-11-02/);
  assert.equal(pending.updatedAt, new Date(now).toISOString());
  await answerReply('いいえ 3', options, deps);
  await run(options, deps);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'))).items, []);
  assert.equal(journal(path.join(dir, 'ledger.jsonl')).rows.filter(r => r.type === 'batch').length, 2);
});
for (const date of ['2026-11-02', '2026-11-03']) test(`answer yes for past/today ${date} appends once and reads back`, async t => {
  const { dir, ledger, c } = setup(t), sheet = fakeSheets();
  // Use a second candidate to cover the JST date boundary (UTC is still Nov 2).
  if (date !== c.date) ledger.save(makeBatch([{ ...c, date }], ledger.rows));
  refreshPending(dir, ledger);
  const number = date === c.date ? 1 : 2;
  const deps = { now: Date.parse('2026-11-02T15:00:00Z'), sheetsFactory: sheet.factory };
  const messages = await answerReply(`はい ${number}`, { stateDir: dir }, deps);
  assert.equal(sheet.appends, 1); assert.equal(sheet.reads, 2);
  assert.match(messages.join('\n'), /1件を報告書に追加しました/);
  assert.match(messages.join('\n'), new RegExp(`日付: ${date}`));
  assert.ok(!JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'))).items.some(c => c.number === number));
  await assert.rejects(answerReply(`はい ${number}`, { stateDir: dir }, deps), /未回答/);
  await run({ stateDir: dir }, { ...deps, events: [], geocode() {}, output() {} });
  assert.equal(sheet.appends, 1);
});
test('future approval schedules, disappears from pending and is recorded on the day', async t => {
  const { dir } = setup(t), sheet = fakeSheets();
  const messages = await answerReply('はい 1', { stateDir: dir }, { now: Date.parse('2026-11-01T12:00:00Z'), sheetsFactory: sheet.factory });
  assert.deepEqual(messages, ['2026-11-02 は当日以降の20:00に報告書へ追記予定']);
  assert.equal(sheet.appends, 0); assert.equal(sheet.reads, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'))).items, []);
  await run({ stateDir: dir }, { now, events: [], geocode() {}, sheetsFactory: sheet.factory, output() {} });
  assert.equal(sheet.appends, 1);
});
test('decline records only; malformed or unknown mixed answers write nothing', async t => {
  const { dir } = setup(t), file = path.join(dir, 'ledger.jsonl'), pending = path.join(dir, 'pending.json');
  const before = fs.readFileSync(file, 'utf8'), pendingBefore = fs.readFileSync(pending, 'utf8');
  const deps = { now, sheetsFactory() { throw new Error('unexpected sheets'); } };
  for (const text of ['はい 1 いいえ 99', 'はい 99', 'はい 1 いいえ 1', 'たぶん 1', '']) {
    await assert.rejects(answerReply(text, { stateDir: dir }, deps));
    assert.equal(fs.readFileSync(file, 'utf8'), before);
    assert.equal(fs.readFileSync(pending, 'utf8'), pendingBefore);
  }
  assert.deepEqual(await answerReply('いいえ 1', { stateDir: dir }, deps), ['2026-11-02 は対象外として記録']);
  assert.deepEqual(JSON.parse(fs.readFileSync(pending)).items, []);
});
test('legacy queue drains all candidates without message length limits', async t => {
  const dir = temp(t), log = journal(path.join(dir, 'ledger.jsonl')), c = fixtureCandidate();
  for (let i = 1; i <= 30; i++) log.save({ type: 'queued', candidate: { ...c, date: `2026-11-${String(i).padStart(2, '0')}`, titles: ['長い予定'.repeat(600)] } });
  await run({ stateDir: dir }, { now, events: [], geocode() {} });
  const pending = JSON.parse(fs.readFileSync(path.join(dir, 'pending.json')));
  assert.equal(pending.items.length, 30);
  assert.ok(pending.items[0].line.length > 2000);
});
test('failed append preserves decisions and refreshes pending for scheduled recovery', async t => {
  const { dir } = setup(t);
  await assert.rejects(answerReply('はい 1', { stateDir: dir }, { now, sheetsFactory: async () => ({ rows: async () => [HEADERS, []], append: async () => { throw new Error('offline'); } }) }), /offline/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'))).items, []);
  const rows = journal(path.join(dir, 'ledger.jsonl')).rows;
  assert.equal(rows.at(-1).type, 'append-intent');
  assert.equal(rows.filter(r => r.type === 'decision').length, 1);
});
test('mixed answers validate together and preserve each outcome', async t => {
  const { dir, ledger, c } = setup(t), sheet = fakeSheets();
  ledger.save(makeBatch([{ ...c, date: '2026-11-10' }, { ...c, date: '2026-11-11' }], ledger.rows));
  refreshPending(dir, ledger);
  const messages = await answerReply('はい 1,2 いいえ 3', { stateDir: dir }, { now, sheetsFactory: sheet.factory });
  assert.equal(sheet.appends, 1);
  assert.ok(messages.includes('2026-11-10 は当日以降の20:00に報告書へ追記予定'));
  assert.ok(messages.includes('2026-11-11 は対象外として記録'));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pending.json'))).items, []);
});
test('answer uses the run lock and CLI rejects unknown numbers without writing a ledger', async t => {
  const home = temp(t), dir = path.join(home, '.claude', 'daytrip-detect');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.lock'), String(process.pid));
  await assert.rejects(answerReply('はい 1', { home }), /already running/);
  fs.unlinkSync(path.join(dir, 'run.lock'));
  const result = spawnSync(process.execPath, ['tools/daytrip-detect.mjs', '--answer', 'はい 99'], { cwd: new URL('../', import.meta.url), encoding: 'utf8', timeout: 30000, env: { ...process.env, ORGIAST_HOME: home, HOME: home } });
  assert.equal(result.status, 1); assert.match(result.stderr, /番号 99 は未回答/); assert.equal(result.stdout, '');
  assert.ok(!fs.existsSync(path.join(dir, 'ledger.jsonl')));
  assert.ok(!fs.existsSync(path.join(dir, 'pending.json')));
});
test('manifest distributes the hook and both synchronous events through converge', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('setup-manifest.json', import.meta.url)));
  const entries = manifest.items.filter(e => e.id.includes('daytrip-ask'));
  assert.equal(entries.length, 3);
  const file = entries.find(e => e.type === 'file-nonempty');
  assert.deepEqual(file.repair, ['onboarding-sync.mjs', '--force']);
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    const entry = entries.find(e => e.spec.hookEvent === event);
    assert.equal(entry.type, 'json-valid'); assert.equal(entry.spec.timeout, 5); assert.equal(entry.spec.async, false);
    assert.equal(entry.spec.hookScript, 'daytrip-ask-hook.mjs');
    assert.deepEqual(entry.repair, ['register-hooks.mjs', '--hooks-only']);
  }
});
