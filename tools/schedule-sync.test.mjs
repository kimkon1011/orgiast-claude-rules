import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScheduleSync, isScheduleCandidate, isDuplicate, eventBody, extractEvents, parseArgs, parseExtraction, calendarToken, CALENDAR_SCOPE, createCalendarClient, collectMessages, makeLlm } from './schedule-sync.mjs';
import { searchGmail } from './gmail-search.mjs';
import { fetchMessages } from './discord-digest.mjs';
import { callWithFallback } from './llm-fallback.mjs';

const now = Date.parse('2026-10-17T09:00:00+09:00');
const message = { source: 'line', id: 'm1', chat: 'ラハイナ PJ', sender: '担当者', ts: '2026-10-16T12:02:00+09:00', text: '10/26 12時から\n全社mtg' };
const candidate = { title: '全社mtg', start: '2026-10-26T12:00:00+09:00', end: null, allDay: false, location: null, confidence: 'high', kind: 'new_event', quote: message.text };
function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schedule-sync-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const creates = [], dms = [];
  const deps = {
    collect: async () => ({ messages: [message], stats: { line: 1 } }),
    llm: async () => JSON.stringify([candidate]),
    calendar: { get: async () => null, list: async () => [], create: async body => { creates.push(body); return { ...body, htmlLink: 'https://calendar.google.com/event?id=test' }; } },
    dm: async text => { dms.push(text); }, log: () => {},
  };
  const options = { now, stateDir: path.join(dir, 'state'), home: dir, sources: ['line'] };
  return { dir, creates, dms, deps, options, run: () => runScheduleSync(options, deps) };
}
const response = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('前段フィルタ: Japanese dates, fullwidth, ordinary conversation, magic placeholders', () => {
  for (const text of [message.text, '10月26日', '１２：３０', '明日お願いします', '明後日', 'あさって', '来週月曜', '今週火曜日', '再来週', '水曜日', '2026-10-26']) assert.equal(isScheduleCandidate(text), true, text);
  for (const text of ['ありがとうございます！', '', null, '{not_text} 12時', '[notification] 12時']) assert.equal(isScheduleCandidate(text), false, String(text));
});
test('ラハイナ既存全社mtgは時間の重なり＋タイトル一致でskip', async t => {
  const x = setup(t);
  x.deps.calendar.list = async () => [{ id: 'existing', summary: '【ラハイナ】全社mtg', start: { dateTime: candidate.start }, end: { dateTime: '2026-10-26T13:00:00+09:00' } }];
  const result = await x.run();
  assert.equal(result.counts.duplicate, 1);
  assert.equal(x.creates.length, 0); assert.equal(x.dms.length, 0);
});
test('new appointment: automatic title, one hour, provenance, default reminders and linked DM', async t => {
  const x = setup(t);
  assert.equal((await x.run()).counts.created, 1);
  assert.equal(x.creates[0].summary, '【自動】【ラハイナ】全社mtg');
  assert.equal(Date.parse(x.creates[0].end.dateTime) - Date.parse(x.creates[0].start.dateTime), 3600000);
  assert.match(x.creates[0].description, /出典: LINE \/ ラハイナ PJ\n送信者: 担当者\n送信日時: 2026-10-16/);
  assert.ok(x.creates[0].description.endsWith(message.text));
  assert.deepEqual(x.creates[0].reminders, { useDefault: true });
  assert.match(x.dms[0], /2026-10-26 12:00.*全社mtg.*LINE.*https:\/\/calendar/);
});
test('past, medium, low, hypothetical, reschedule and cancel never create', async t => {
  const x = setup(t);
  x.deps.llm = async () => [
    { ...candidate, start: '2026-10-16T12:00:00+09:00' }, { ...candidate, confidence: 'medium' },
    { ...candidate, confidence: 'low' }, ...['past_or_hypothetical', 'reschedule', 'cancel'].map(kind => ({ ...candidate, kind })),
  ];
  const result = await x.run();
  assert.equal(result.counts.ignored, 5); assert.equal(result.counts.review, 1);
  assert.equal(x.creates.length, 0); assert.match(x.dms[0], /確認候補.*未登録/);
});
test('ledger prevents extracting, creating or notifying a processed message twice', async t => {
  const x = setup(t);
  await x.run();
  x.deps.llm = () => { throw new Error('must not extract twice'); };
  assert.equal((await x.run()).alreadyProcessed, 1);
  assert.equal(x.creates.length, 1); assert.equal(x.dms.length, 1);
  const ledger = fs.readFileSync(path.join(x.options.stateDir, 'ledger.jsonl'), 'utf8');
  assert.match(ledger, /"messageKey":"line:ラハイナ PJ:m1:/); assert.match(ledger, /"eventId":"[a-f0-9]{64}"/);
});
test('dry-run has no Calendar, DM, cursor, ledger, lock or directory writes', async t => {
  const x = setup(t); x.options.dryRun = true;
  assert.equal((await x.run()).counts['would-create'], 1);
  assert.equal(x.creates.length, 0); assert.equal(x.dms.length, 0);
  assert.equal(fs.existsSync(x.options.stateDir), false);
});
test('dry-run preserves preexisting state and ledger byte-for-byte', async t => {
  const x = setup(t); await x.run();
  const files = fs.readdirSync(x.options.stateDir);
  const before = files.map(f => fs.readFileSync(path.join(x.options.stateDir, f), 'utf8'));
  x.options.dryRun = true; await x.run();
  assert.deepEqual(fs.readdirSync(x.options.stateDir), files);
  assert.deepEqual(files.map(f => fs.readFileSync(path.join(x.options.stateDir, f), 'utf8')), before);
});
test('bad JSON retries once, then logs skip; transport failure is not swallowed', async () => {
  let calls = 0;
  assert.deepEqual(await extractEvents(message, async () => ++calls === 1 ? 'bad' : JSON.stringify([candidate])), [candidate]);
  assert.equal(calls, 2);
  calls = 0; const logs = [];
  assert.equal(await extractEvents(message, async () => { calls++; return '{}'; }, log => logs.push(log)), null);
  assert.equal(calls, 2); assert.equal(logs.length, 1);
  await assert.rejects(extractEvents(message, async () => { throw new Error('network'); }), /network/);
});
test('schema rejects invented evidence, impossible dates, ambiguous timezone, inverted end, malformed all-day', () => {
  for (const changes of [{ quote: 'invented' }, { start: '2026-02-30T12:00:00+09:00' }, { start: '2026-10-26T12:00:00' }, { end: '2026-10-26T11:00:00+09:00' }, { allDay: true }, { confidence: 'HIGH' }]) {
    assert.throws(() => parseExtraction([{ ...candidate, ...changes }], message));
  }
});
test('all-day uses exclusive next-day date; explicit end and location are kept', () => {
  const event = eventBody({ ...candidate, allDay: true, start: '2026-10-26T00:00:00+09:00', location: '本社' }, message, 0);
  assert.deepEqual(event.start, { date: '2026-10-26' }); assert.deepEqual(event.end, { date: '2026-10-27' }); assert.equal(event.location, '本社');
  const timed = eventBody({ ...candidate, end: '2026-10-26T14:00:00+09:00' }, message, 0);
  assert.equal(Date.parse(timed.end.dateTime), Date.parse('2026-10-26T14:00:00+09:00'));
});
test('adjacent times, unrelated titles and cancelled events are not duplicates', () => {
  const event = { summary: '全社mtg', start: { dateTime: candidate.start }, end: { dateTime: '2026-10-26T13:00:00+09:00' } };
  assert.equal(isDuplicate(candidate, { ...event, summary: '採用面接' }), false);
  assert.equal(isDuplicate(candidate, { ...event, status: 'cancelled' }), false);
  assert.equal(isDuplicate({ ...candidate, start: '2026-10-26T13:00:00+09:00' }, event), false);
  assert.equal(isDuplicate(candidate, { ...event, start: { date: '2026-10-26' }, end: { date: '2026-10-27' } }), true);
});
test('crash after insertion recovers deterministic event ID and original extraction without a second insert', async t => {
  const x = setup(t); let inserted;
  x.deps.calendar.create = async body => { inserted = body; throw new Error('response lost'); };
  await assert.rejects(x.run(), /response lost/);
  assert.equal(fs.existsSync(path.join(x.options.stateDir, 'state.json')), false);
  x.deps.collect = async () => ({ messages: [], stats: {} });
  x.deps.llm = () => { throw new Error('must use saved plan'); };
  x.deps.calendar.get = async id => { assert.equal(id, inserted.id); return inserted; };
  assert.equal((await x.run()).counts.created, 1);
  assert.equal(x.dms.length, 1);
});
test('DM failure retries reporting from ledger without recreating or losing the report', async t => {
  const x = setup(t);
  x.deps.dm = async () => { throw new Error('DM denied'); };
  await assert.rejects(x.run(), /DM denied/);
  assert.equal(fs.existsSync(path.join(x.options.stateDir, 'state.json')), false);
  x.deps.dm = async text => x.dms.push(text);
  await x.run();
  assert.equal(x.creates.length, 1); assert.equal(x.dms.length, 1);
});
test('multiple appointments per message and DM chunking preserve every link', async t => {
  const x = setup(t);
  x.deps.llm = async () => Array.from({ length: 20 }, (_, i) => ({ ...candidate, title: `予定${i} ${'あ'.repeat(140)}` }));
  await x.run();
  assert.equal(x.creates.length, 20); assert.ok(x.dms.length > 1);
  assert.ok(x.dms.every(s => s.length < 2000));
  assert.equal(x.dms.join('\n').match(/https:\/\/calendar/g).length, 20);
});
test('collection / LLM failures retain cursor; empty run sends no DM', async t => {
  const x = setup(t);
  x.deps.collect = async () => { throw new Error('Gmail failed'); };
  await assert.rejects(x.run(), /Gmail failed/);
  assert.equal(fs.existsSync(path.join(x.options.stateDir, 'state.json')), false);
  x.deps.collect = async () => ({ messages: [], stats: {} });
  await x.run(); assert.equal(x.dms.length, 0);
  const before = fs.readFileSync(path.join(x.options.stateDir, 'state.json'), 'utf8');
  x.deps.collect = async () => ({ messages: [message], stats: {} });
  x.deps.llm = async () => { throw new Error('LLM failed'); };
  x.options.now += 1000;
  await assert.rejects(x.run(), /LLM failed/);
  assert.equal(fs.readFileSync(path.join(x.options.stateDir, 'state.json'), 'utf8'), before);
});
test('source-specific cursors retain other sources; --since overrides reads without moving cursor backward', async t => {
  const x = setup(t);
  fs.mkdirSync(x.options.stateDir);
  fs.writeFileSync(path.join(x.options.stateDir, 'state.json'), JSON.stringify({ cursors: { gmail: '2026-10-16T00:00:00Z', line: '2026-10-18T00:00:00Z' } }));
  x.options.since = '2026-10-15T00:00:00+09:00';
  x.deps.collect = async ({ since }) => { assert.equal(since.line, Date.parse(x.options.since)); return { messages: [], stats: {} }; };
  await x.run();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.options.stateDir, 'state.json'))).cursors, { gmail: '2026-10-16T00:00:00Z', line: '2026-10-18T00:00:00.000Z' });
});
test('concurrent live process lock and corrupt ledger fail closed', async t => {
  const x = setup(t); fs.mkdirSync(x.options.stateDir);
  fs.writeFileSync(path.join(x.options.stateDir, 'run.lock'), String(process.pid));
  await assert.rejects(x.run(), /already running/);
  fs.unlinkSync(path.join(x.options.stateDir, 'run.lock'));
  fs.writeFileSync(path.join(x.options.stateDir, 'ledger.jsonl'), '{');
  await assert.rejects(x.run(), /ledger.jsonl/); assert.equal(x.creates.length, 0);
});
test('Calendar DWD rejection includes scope/client ID; live aborts and dry-run reports unverified candidates', async t => {
  const x = setup(t); const keyPath = path.join(x.dir, 'key.json');
  fs.writeFileSync(keyPath, JSON.stringify({ client_id: '123456' }));
  await assert.rejects(calendarToken({ keyPath, getToken: async opts => { assert.equal(opts.scope, CALENDAR_SCOPE); assert.equal(opts.impersonate, 'kim@orgiast.jp'); throw new Error('unauthorized_client'); } }), error => /123456/.test(error.message) && error.message.includes(CALENDAR_SCOPE));
  delete x.deps.calendar;
  x.deps.getCalendarToken = async () => { throw new Error('unauthorized_client'); };
  await assert.rejects(x.run(), /unauthorized_client/);
  x.options.dryRun = true;
  const result = await x.run();
  assert.equal(result.ok, false); assert.equal(result.counts['calendar-unverified'], 1); assert.equal(x.creates.length, 0);
});
test('Calendar lists all pages within ±3h and recovers 409 without another POST', async () => {
  const urls = []; let posts = 0;
  const calendar = createCalendarClient('test', async (url, init) => {
    urls.push(url);
    if (init.method === 'POST') { posts++; return response({}, 409); }
    if (url.endsWith('/abcde')) return response({ id: 'abcde' });
    const parsed = new URL(url);
    assert.equal(Date.parse(parsed.searchParams.get('timeMin')), Date.parse(candidate.start) - 3 * 3600000);
    assert.equal(Date.parse(parsed.searchParams.get('timeMax')), Date.parse(candidate.start) + 3 * 3600000);
    return response({ items: [{ id: parsed.searchParams.get('pageToken') || 'first' }], ...(parsed.searchParams.has('pageToken') ? {} : { nextPageToken: 'second' }) });
  });
  assert.equal((await calendar.list(candidate.start)).length, 2);
  assert.deepEqual(await calendar.create({ id: 'abcde' }), { id: 'abcde' }); assert.equal(posts, 1);
});
test('Gmail pagination reuses searchGmail and preserves arrival timestamp', async () => {
  const urls = [];
  const result = await searchGmail({ user: 'kim@orgiast.jp', query: 'after:1', max: 100, withBody: true, pageToken: 'p 2', getToken: async () => 't', fetchImpl: async url => {
    urls.push(url);
    return url.includes('/messages?') ? response({ messages: [{ id: '1' }], nextPageToken: 'p3' }) : response({ id: '1', internalDate: String(now), payload: { headers: [] } });
  } });
  assert.match(urls[0], /pageToken=p%202/); assert.equal(result.nextPageToken, 'p3'); assert.equal(result.messages[0].internalDate, String(now));
});
test('collectors paginate Gmail and Discord, ignore bots, and include delayed LINE arrivals', async t => {
  const x = setup(t);
  const inbox = path.join(x.dir, '.claude', 'schedule-inbox'); fs.mkdirSync(inbox, { recursive: true });
  fs.writeFileSync(path.join(inbox, 'line-2026-10.jsonl'), JSON.stringify({ ...message, ts: now - 10 * 86400000, receivedAt: new Date(now - 1000).toISOString() }) + '\n');
  const tokenDir = path.join(x.dir, '.claude'); fs.writeFileSync(path.join(tokenDir, 'orgiast-discord-bot-token.txt'), 'test');
  let gmailPages = 0, discordPages = 0;
  const result = await collectMessages({ sources: ['line', 'gmail', 'discord'], home: x.dir, since: { line: now - 86400000, gmail: now - 86400000, discord: now - 86400000 }, until: now, log: () => {},
    gmailSearch: async opts => { gmailPages++; assert.equal(opts.withBody, true); return { messages: [{ id: String(gmailPages), internalDate: now - 500, subject: '明日', body: '12時', from: 'sender' }], nextPageToken: opts.pageToken ? null : 'p2' }; },
    listChannels: async () => [{ id: 'a', type: 0, name: 'team' }, { id: 'b', type: 0 }, { id: 'v', type: 2 }],
    discordFetch: async opts => {
      if (opts.channelId === 'b') throw Object.assign(new Error('Forbidden'), { status: 403 });
      discordPages++;
      return { messages: [{ id: String(discordPages), content: '明日12時', timestamp: new Date(now - 1000).toISOString(), author: { bot: Boolean(opts.before) } }], truncated: !opts.before };
    },
  });
  assert.equal(gmailPages, 2); assert.equal(discordPages, 2);
  assert.deepEqual(result.stats, { line: 1, gmail: 2, discordChannels: { readable: 1, denied: 1 }, discord: 1 });
  assert.equal(result.messages.length, 4);
});
test('Discord fetch supports continuing before an ID and surfaces forbidden status', async () => {
  await fetchMessages({ channelId: 'test', before: '123', token: 't', fetchImpl: async url => { assert.equal(url.searchParams.get('before'), '123'); return response([]); } });
  await assert.rejects(fetchMessages({ channelId: 'test', token: 't', fetchImpl: async () => response({}, 403) }), error => error.status === 403);
});
test('LLM CLI uses extraction routing, reference timestamp, and no-persist for dry run', async () => {
  const llm = makeLlm({ home: '/tmp', dryRun: true, execute: async (file, args) => {
    assert.equal(file, process.execPath); assert.ok(args.includes('--no-persist'));
    assert.equal(args[args.indexOf('--category') + 1], 'extraction');
    assert.equal(JSON.parse(args.at(-1)).sentAt, message.ts); return { stdout: '[]' };
  } });
  assert.equal(await llm(message, false), '[]');
});
test('LLM fallback no-persist does not write cooldown or rate budget on failure/fallback', async t => {
  const x = setup(t); let calls = 0;
  await callWithFallback({ start: { provider: 'groq', model: 'a' }, chain: [{ provider: 'openrouter', model: 'b' }], allowGatewayFallback: false,
    cooldownFile: path.join(x.dir, 'cooldown.json'), budgetFile: path.join(x.dir, 'budget.json'), persistState: false,
    payloadFor: () => ({ url: 'https://example.invalid', init: {} }),
    fetchImpl: async () => ++calls === 1 ? response({}, 402) : response({}),
  });
  assert.equal(fs.existsSync(path.join(x.dir, 'cooldown.json')), false); assert.equal(fs.existsSync(path.join(x.dir, 'budget.json')), false);
});
test('argument errors are explicit', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--source', 'gmail,discord', '--since', '2026-10-15T00:00:00+09:00', '--json']), { dryRun: true, sources: ['gmail', 'discord'], since: '2026-10-15T00:00:00+09:00', json: true });
  for (const args of [['--source'], ['--since', 'no'], ['--source', 'no'], ['--bogus']]) assert.throws(() => parseArgs(args));
});
test('task scripts use BOM/CRLF, synced main, 30 minutes, and both deployment paths', () => {
  for (const name of ['register-schedule-sync-task.ps1', 'fleet-poller.ps1', 'install-orgiast.ps1']) {
    const buffer = fs.readFileSync(new URL(`./${name}`, import.meta.url));
    assert.equal(buffer.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.equal(/(?<!\r)\n/.test(buffer.toString()), false);
    if (name !== 'register-schedule-sync-task.ps1') assert.match(buffer.toString(), /register-schedule-sync-task\.ps1/);
  }
  const text = fs.readFileSync(new URL('./register-schedule-sync-task.ps1', import.meta.url), 'utf8');
  assert.match(text, /\.claude\\nightly-repo/); assert.match(text, /-RepetitionInterval \(New-TimeSpan -Minutes 30\)/); assert.match(text, /-MultipleInstances IgnoreNew/);
  assert.match(text, /Downloads\\claude-mobile\\app\\api\\line-ingest/);
});
