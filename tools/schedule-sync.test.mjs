import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runScheduleSync, isScheduleCandidate, isDuplicate, eventBody, extractEvents, parseArgs, parseExtraction, calendarToken, CALENDAR_SCOPE, createCalendarClient, collectMessages, makeLlm, parseBatchExtraction, extractBatch, isAutomatedGmail, excerptScheduleText, main } from './schedule-sync.mjs';
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
test('dry-run has no Calendar, DM or persistent state writes', async t => {
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.options.stateDir, 'state.json'))).cursors.line, new Date(now - 48 * 3600000).toISOString());
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.options.stateDir, 'state.json'))).cursors.line, new Date(now - 48 * 3600000).toISOString());
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
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.options.stateDir, 'state.json'))).cursors.line, new Date(now - 48 * 3600000).toISOString());
  x.deps.collect = async () => ({ messages: [], stats: {} });
  await x.run(); assert.equal(x.dms.length, 0);
  const before = fs.readFileSync(path.join(x.options.stateDir, 'state.json'), 'utf8');
  x.deps.collect = async () => ({ messages: [message], stats: {} });
  x.deps.llm = async () => { throw new Error('LLM failed'); };
  x.options.now += 1000;
  assert.equal((await x.run()).ok, false);
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
    gmailSearch: async opts => { gmailPages++; assert.equal(opts.withBody, true); assert.doesNotMatch(opts.query, /to:/); return { messages: [{ id: String(gmailPages), internalDate: now - 500, subject: '明日', body: '12時', from: 'sender' }], nextPageToken: opts.pageToken ? null : 'p2' }; },
    listChannels: async () => [{ id: 'a', type: 0, name: 'team' }, { id: 'b', type: 0 }, { id: 'v', type: 2 }],
    discordFetch: async opts => {
      if (opts.channelId === 'b') throw Object.assign(new Error('Forbidden'), { status: 403 });
      discordPages++;
      return { messages: [{ id: String(discordPages), content: '明日12時', timestamp: new Date(now - 1000).toISOString(), author: { bot: Boolean(opts.before) } }], truncated: !opts.before };
    },
  });
  assert.equal(gmailPages, 2); assert.equal(discordPages, 2);
  assert.deepEqual(result.stats, { line: 1, gmail: 2, discordChannels: { readable: 1, denied: 1, cached: 0 }, discord: 1 });
  assert.equal(result.messages.length, 4);
});
test('Discord fetch supports continuing before an ID and surfaces forbidden status', async () => {
  await fetchMessages({ channelId: 'test', before: '123', token: 't', fetchImpl: async url => { assert.equal(url.searchParams.get('before'), '123'); return response([]); } });
  await assert.rejects(fetchMessages({ channelId: 'test', token: 't', fetchImpl: async () => response({}, 403) }), error => error.status === 403);
});
test('LLM CLI uses extraction routing, reference timestamp, and no-persist for dry run', async () => {
  const llm = makeLlm({ home: '/tmp', dryRun: true, execute: async (file, args) => {
    assert.equal(file, process.execPath); assert.ok(args.includes('--no-persist'));
    assert.ok(!args.includes('--no-fallback'));
    assert.equal(args[args.indexOf('--category') + 1], 'extraction');
    assert.equal(JSON.parse(fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8')).sentAt, message.ts); return { stdout: '[]' };
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
  assert.match(text, /Resolve-RegisterRepoRoot -Fallback \(Get-SyncedRepoRoot\)/); assert.match(text, /-RepetitionInterval \(New-TimeSpan -Minutes 30\)/); assert.match(text, /-MultipleInstances IgnoreNew/);
  assert.match(text, /Downloads\\claude-mobile\\app\\api\\line-ingest/);
});

test('interrupted initial backfill pins its lower bound across later runs', async t => {
  const x = setup(t);
  const cutoffs = [];
  x.deps.collect = async ({ since }) => { cutoffs.push(since.line); throw new Error('temporary source failure'); };
  await assert.rejects(x.run(), /temporary source failure/);
  x.options.now += 6 * 3600000;
  await assert.rejects(x.run(), /temporary source failure/);
  assert.deepEqual(cutoffs, [now - 48 * 3600000, now - 48 * 3600000]);
});

test('a start time that passes during API reads is not inserted', async t => {
  const x = setup(t); let current = now;
  x.deps.now = () => current;
  x.deps.calendar.list = async () => { current = Date.parse(candidate.start) + 1; return []; };
  assert.equal((await x.run()).counts.ignored, 1);
  assert.equal(x.creates.length, 0); assert.equal(x.dms.length, 0);
});

const batchId = m => `${m.source}:${m.channelId || m.chat || ''}:${m.id}${m.source === 'line' ? `:${m.ts}` : ''}`;
const batchReply = messages => messages.map(m => ({ id: batchId(m), events: [{ ...candidate, title: m.id, quote: m.text }] }));

test('batch IDs preserve attribution when reordered and reject missing, duplicate, unknown IDs or swapped evidence', async () => {
  const messages = [message, { ...message, id: 'm2', text: '10/27 13時に打合せ' }];
  const reply = batchReply(messages).reverse();
  const result = parseBatchExtraction(JSON.stringify(reply), messages);
  assert.equal(result.get(batchId(message))[0].title, 'm1');
  assert.equal(result.get(batchId(messages[1]))[0].quote, messages[1].text);
  for (const rows of [reply.slice(0, 1), [reply[0], reply[0]], [{ ...reply[0], id: 'unknown' }, reply[1]], reply.map((row, i) => ({ ...row, events: reply[1 - i].events }))]) {
    assert.throws(() => parseBatchExtraction(rows, messages));
  }
  let calls = 0;
  assert.equal((await extractBatch(messages, async () => ++calls === 1 ? [] : reply)).size, 2);
  assert.equal(calls, 2);
  await assert.rejects(extractBatch(messages, async () => []), /cursor retained/);
});

test('LLM batch prompt includes exact IDs and uses independent message envelopes', async () => {
  const llm = makeLlm({ home: '/tmp', dryRun: true, execute: async (file, args) => {
    const input = JSON.parse(fs.readFileSync(args[args.indexOf('--prompt-file') + 1], 'utf8'));
    assert.deepEqual(input.messages.map(m => m.id), [batchId(message)]);
    assert.equal(input.messages[0].sentAt, message.ts);
    assert.match(args[args.indexOf('--system') + 1], /別メッセージの予定や引用を混ぜない/);
    return { stdout: '[]' };
  } });
  assert.equal(await llm([message]), '[]');
});

test('bounded batches run concurrently and stop at the configured message limit', async t => {
  const x = setup(t); delete x.deps.llm;
  x.options.dryRun = true;
  const messages = Array.from({ length: 65 }, (_, i) => ({ ...message, id: `m${i}` }));
  x.deps.collect = async () => ({ messages, stats: {} });
  let active = 0, peak = 0, calls = 0;
  x.deps.batchLlm = async batch => {
    assert.equal(batch.length, 10); calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
    return batchReply(batch).reverse();
  };
  const result = await x.run();
  assert.equal(result.processed, 60); assert.equal(result.deferred, 5);
  assert.equal(calls, 6); assert.equal(peak, 3);
  assert.equal(new Set(result.candidates.map(c => c.title)).size, 60);
});

test('cap preserves tied timestamps and delayed LINE arrivals for the next run', async t => {
  const x = setup(t); delete x.deps.llm;
  x.options.maxMessages = 1;
  const receivedAt = new Date(now - 1000).toISOString();
  const messages = [0, 1, 2].map(i => ({ ...message, id: `m${i}`, ts: '2026-10-01T00:00:00+09:00', receivedAt }));
  const extracted = [];
  x.deps.collect = async ({ since }) => ({ messages: messages.filter(m => Date.parse(m.receivedAt) >= since.line), stats: {} });
  x.deps.batchLlm = async batch => { extracted.push(...batch.map(m => m.id)); return batchReply(batch); };
  const cursor = () => JSON.parse(fs.readFileSync(path.join(x.options.stateDir, 'state.json'))).cursors.line;
  assert.equal((await x.run()).deferred, 2); assert.equal(cursor(), receivedAt);
  assert.equal((await x.run()).deferred, 1); assert.equal(cursor(), receivedAt);
  assert.equal((await x.run()).deferred, 0); assert.equal(cursor(), new Date(now).toISOString());
  assert.deepEqual(extracted, ['m0', 'm1', 'm2']);
});

test('each source cursor stops at its own unprocessed boundary in chronological order', async t => {
  const x = setup(t); delete x.deps.llm;
  x.options.sources = ['gmail', 'discord']; x.options.maxMessages = 1;
  const messages = [
    { ...message, source: 'gmail', id: 'later', ts: new Date(now - 1000).toISOString() },
    { ...message, source: 'discord', id: 'earliest', ts: new Date(now - 3000).toISOString() },
    { ...message, source: 'discord', id: 'next', ts: new Date(now - 2000).toISOString() },
  ];
  x.deps.collect = async ({ since }) => ({ messages: messages.filter(m => Date.parse(m.ts) >= since[m.source]), stats: {} });
  x.deps.batchLlm = async batch => batch.map(m => ({ id: batchId(m), events: [] }));
  await x.run();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.options.stateDir, 'state.json'))).cursors, { gmail: messages[0].ts, discord: messages[2].ts });
  assert.equal((await x.run()).processed, 1);
  assert.equal((await x.run()).processed, 1);
});

test('automated Gmail exclusion uses headers, category labels and sender address, not display names', () => {
  for (const row of [{ from: 'Gemini <gemini-notes@google.com>' }, { listUnsubscribe: '<https://example.com/unsubscribe>' }, { labels: ['CATEGORY_PROMOTIONS'] }, { labels: ['CATEGORY_SOCIAL'] }, { labels: ['CATEGORY_FORUMS'] }, ...['noreply', 'no-reply', 'no_reply', 'notifications', 'notification', 'do-not-reply', 'noreply+news'].map(local => ({ from: `Service <${local}@example.com>` }))]) assert.equal(isAutomatedGmail(row), true, JSON.stringify(row));
  for (const from of ['Alice <alice@example.com>', 'noreply <human@example.com>', 'person+notifications@example.com', 'gemini-notes@example.com', 'gemini-notes@google.com.example.org']) {
    assert.equal(isAutomatedGmail({ from }), false, from);
  }
});

test('Gmail header is preserved and collectors exclude automated mail, bot and webhook posts before extraction', async t => {
  const x = setup(t);
  fs.mkdirSync(path.join(x.dir, '.claude')); fs.writeFileSync(path.join(x.dir, '.claude', 'orgiast-discord-bot-token.txt'), 'test');
  const gmail = await searchGmail({ user: 'test', query: '', withBody: true, getToken: async () => 't', fetchImpl: async url => response(url.includes('/messages?') ? { messages: [{ id: '1' }] } : { id: '1', payload: { headers: [{ name: 'List-Unsubscribe', value: '<mailto:unsub@example.com>' }] } }) });
  assert.equal(gmail.messages[0].listUnsubscribe, '<mailto:unsub@example.com>');
  const result = await collectMessages({ sources: ['gmail', 'discord'], home: x.dir, since: { gmail: now - 1000, discord: now - 1000 }, until: now, log: () => {},
    gmailSearch: async () => ({ messages: [{ id: 'human' }, { id: 'auto-notes', from: 'Gemini <gemini-notes@google.com>' }, { id: 'header', listUnsubscribe: '<url>' }, { id: 'sender', from: 'notifications@example.com' }, { id: 'category', labels: ['CATEGORY_PROMOTIONS'] }].map(row => ({ internalDate: now, subject: message.text, ...row })) }),
    listChannels: async () => [{ id: 'channel', type: 0 }],
    discordFetch: async () => ({ messages: [{ id: 'human', author: { bot: false } }, { id: 'own-bot', author: { bot: true } }, { id: 'webhook', webhook_id: 'webhook' }].map(row => ({ timestamp: new Date(now).toISOString(), content: message.text, ...row })) }),
  });
  assert.deepEqual(result.messages.map(m => `${m.source}:${m.id}`), ['gmail:human', 'discord:human']);
});

test('overall timeout cancels LLM work, retains cursors, releases lock and prevents late writes', async t => {
  const x = setup(t); delete x.deps.llm;
  x.options.timeoutMs = 25;
  let finish;
  x.deps.batchLlm = async () => new Promise(resolve => { finish = resolve; });
  await assert.rejects(x.run(), /overall timeout/);
  assert.equal(fs.existsSync(path.join(x.options.stateDir, 'run.lock')), false);
  const state = fs.readFileSync(path.join(x.options.stateDir, 'state.json'), 'utf8');
  finish(batchReply([message]));
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(fs.readFileSync(path.join(x.options.stateDir, 'state.json'), 'utf8'), state);
  assert.equal(x.creates.length, 0); assert.equal(x.dms.length, 0);
  assert.equal(fs.existsSync(path.join(x.options.stateDir, 'ledger.jsonl')), false);
  x.options.timeoutMs = 1000; x.deps.batchLlm = async batch => batchReply(batch);
  assert.equal((await x.run()).counts.created, 1);
});

test('timeout includes collection and dry-run overlaps are locked without persistent state writes', async t => {
  const x = setup(t); x.options.dryRun = true; x.options.timeoutMs = 30;
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  x.deps.collect = async () => { started(); return new Promise(() => {}); };
  const pending = assert.rejects(x.run(), /overall timeout/);
  await ready;
  await assert.rejects(x.run(), /already running/);
  await pending;
  assert.equal(fs.existsSync(x.options.stateDir), false);
});

test('invalid batch retains retry boundary while successful parallel plans are registered', async t => {
  const x = setup(t); delete x.deps.llm; x.options.batchSize = 1;
  x.deps.collect = async () => ({ messages: [message, { ...message, id: 'bad' }], stats: {} });
  x.deps.batchLlm = async batch => batch[0].id === 'bad' ? [] : batchReply(batch);
  const result = await x.run();
  assert.equal(result.ok, true); assert.equal(result.counts.failed, 1);
  assert.equal(result.counts.created, 1); assert.equal(x.creates.length, 1);
  const ledger = fs.readFileSync(path.join(x.options.stateDir, 'ledger.jsonl'), 'utf8');
  assert.match(ledger, /"type":"plan"/); assert.match(ledger, /"type":"done"/); assert.match(ledger, /"type":"failed"/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(x.options.stateDir, 'state.json'))).cursors.line, new Date(message.ts).toISOString());
});

test('batch and runtime CLI limits reject invalid values', () => {
  assert.deepEqual(parseArgs(['--max-messages', '60', '--batch-size', '10', '--concurrency', '4', '--timeout-ms', '1200000']), { maxMessages: 60, batchSize: 10, concurrency: 4, timeoutMs: 1200000 });
  for (const args of [['--max-messages', '0'], ['--batch-size', '11'], ['--concurrency', '5'], ['--timeout-ms', '-1'], ['--max-messages', '1.2'], ['--max-messages']]) assert.throws(() => parseArgs(args));
});

test('long batch prompts bypass command-line limits and temporary files are cleaned on success and failure', async () => {
  for (const fail of [false, true]) {
    let promptFile;
    const llm = makeLlm({ home: '/tmp', dryRun: true, execute: async (file, args) => {
      assert.ok(args.join(' ').length < 4000);
      promptFile = args[args.indexOf('--prompt-file') + 1];
      assert.equal(JSON.parse(fs.readFileSync(promptFile, 'utf8')).messages[0].text.length, 4000);
      if (fail) throw new Error('test failure');
      return { stdout: '[]' };
    } });
    const call = llm([{ ...message, text: 'あ'.repeat(50000) }]);
    if (fail) await assert.rejects(call, /LLM call failed/); else assert.equal(await call, '[]');
    assert.equal(fs.existsSync(path.dirname(promptFile)), false);
  }
});

test('failed batches split recursively to singletons without exceeding worker concurrency', async t => {
  const x = setup(t); delete x.deps.llm;
  const messages = Array.from({ length: 8 }, (_, i) => ({ ...message, id: `split-${i}` }));
  x.deps.collect = async () => ({ messages, stats: {} });
  const sizes = []; let active = 0, peak = 0;
  x.deps.batchLlm = async batch => {
    sizes.push(batch.length); active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 1)); active--;
    if (batch.length > 1) throw new Error('groq HTTP413: payload too large');
    return batchReply(batch);
  };
  const result = await x.run();
  assert.equal(result.ok, true); assert.equal(result.counts.created, 8);
  assert.equal(result.counts.failed, 0); assert.equal(result.successful, 8);
  assert.deepEqual(sizes, [8, 4, 2, 1, 1, 2, 1, 1, 4, 2, 1, 1, 2, 1, 1]);
  assert.equal(peak, 1);
});

test('one failed message is retried from ledger, skipped on run three, and never blocks successful messages', async t => {
  const x = setup(t); delete x.deps.llm;
  const bad = { ...message, id: 'bad', receivedAt: new Date(now - 2000).toISOString() };
  const good = { ...message, id: 'good', receivedAt: new Date(now - 1000).toISOString() };
  x.deps.collect = async () => ({ messages: [good, bad], stats: {} });
  x.deps.batchLlm = async batch => {
    if (batch.some(m => m.id === 'bad')) throw new Error('provider HTTP500');
    return batchReply(batch);
  };
  const state = () => JSON.parse(fs.readFileSync(path.join(x.options.stateDir, 'state.json')));
  const first = await x.run();
  assert.equal(first.ok, true); assert.equal(first.counts.created, 1);
  assert.equal(first.failures[0].attempts, 1); assert.equal(state().cursors.line, bad.receivedAt);
  // Source retention/deletion must not erase a pending retry.
  x.deps.collect = async () => ({ messages: [], stats: {} });
  const second = await x.run();
  assert.equal(second.ok, false); assert.equal(second.failures[0].attempts, 2);
  assert.equal(state().cursors.line, bad.receivedAt);
  const third = await x.run();
  assert.equal(third.ok, false); assert.equal(third.counts.skipped, 1);
  assert.equal(third.counts.failed, 0); assert.equal(state().cursors.line, new Date(now).toISOString());
  assert.equal((await x.run()).failures.length, 0); assert.equal(x.creates.length, 1);
  const ledger = fs.readFileSync(path.join(x.options.stateDir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(ledger.filter(r => r.type === 'failed').map(r => r.attempts), [1, 2, 3]);
  assert.equal(ledger.find(r => r.status === 'skipped').attempts, 3);
});

test('dry-run failures never increment attempts or advance a retry cursor', async t => {
  const x = setup(t);
  x.deps.llm = async () => { throw new Error('HTTP401'); };
  await x.run();
  const files = ['state.json', 'ledger.jsonl'];
  const before = files.map(f => fs.readFileSync(path.join(x.options.stateDir, f), 'utf8'));
  x.options.dryRun = true;
  for (let i = 0; i < 3; i++) assert.equal((await x.run()).failures[0].attempts, 2);
  assert.deepEqual(files.map(f => fs.readFileSync(path.join(x.options.stateDir, f), 'utf8')), before);
});

test('partial failures exit zero at CLI; all failed exits nonzero, including invalid JSON', async t => {
  const x = setup(t); delete x.deps.llm;
  t.mock.method(console, 'log', () => {});
  const bad = { ...message, id: 'bad' };
  x.deps.collect = async () => ({ messages: [message, bad], stats: {} });
  x.deps.batchLlm = async batch => batch.some(m => m.id === 'bad') ? '{}' : batchReply(batch);
  // --dry-run and a test home isolate the real CLI without touching production.
  const oldHome = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = x.dir;
  t.after(() => { if (oldHome === undefined) delete process.env.ORGIAST_HOME; else process.env.ORGIAST_HOME = oldHome; });
  assert.equal(await main(['--dry-run', '--source', 'line'], x.deps), 0);
  x.deps.collect = async () => ({ messages: [bad], stats: {} });
  assert.equal(await main(['--dry-run', '--source', 'line'], x.deps), 1);
});

test('retry boundary is per source and includes tied timestamps, while later successes stay deduplicated', async t => {
  const x = setup(t); delete x.deps.llm;
  x.options.sources = ['gmail', 'discord'];
  const messages = [
    { ...message, source: 'gmail', id: 'bad' },
    { ...message, source: 'gmail', id: 'tie' },
    { ...message, source: 'discord', id: 'ok' },
  ];
  x.deps.collect = async () => ({ messages, stats: {} });
  x.deps.batchLlm = async batch => {
    if (batch.some(m => m.id === 'bad')) throw new Error('timeout');
    return batch.map(m => ({ id: batchId(m), events: [] }));
  };
  await x.run();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(x.options.stateDir, 'state.json'))).cursors, {
    gmail: new Date(message.ts).toISOString(), discord: new Date(now).toISOString(),
  });
  const calls = [];
  x.deps.batchLlm = async batch => { calls.push(...batch.map(m => m.id)); return batch.map(m => ({ id: batchId(m), events: [] })); };
  assert.equal((await x.run()).ok, true);
  assert.deepEqual(calls, ['bad']);
});

test('long mail uses original date context, handles fullwidth dates and bounds dense inputs', () => {
  const text = '広告'.repeat(5000) + '\n重要な打合せは１０月２６日１２：００です。確定しました。\n' + '署名'.repeat(5000);
  const excerpt = excerptScheduleText(text);
  assert.ok(excerpt.length <= 4000); assert.match(excerpt, /重要な打合せは１０月２６日１２：００です。確定しました。/);
  assert.ok(text.includes(excerpt));
  assert.equal(excerptScheduleText(message.text), message.text);
  assert.ok(excerptScheduleText('明日12時\n'.repeat(4000)).length <= 4000);
  const separated = 'あ'.repeat(5000) + '明日の打合せ' + 'い'.repeat(5000) + '来週の会議' + 'う'.repeat(5000);
  assert.match(excerptScheduleText(separated), /明日の打合せ.*\n\[…\]\n.*来週の会議/s);
});

test('LLM diagnostics retain provider, HTTP status, message prefix and timeout information', async () => {
  const logs = [];
  const llm = makeLlm({ home: '/tmp', dryRun: true, log: s => logs.push(s), execute: async () => ({ stdout: '[]', stderr: '[failover] groq HTTP413: too large → openrouter\n[openrouter:model] in=1 out=2tok' }) });
  assert.equal(await llm(message), '[]'); assert.match(logs[0], /groq HTTP413/);
  const fail = makeLlm({ home: '/tmp', dryRun: true, execute: async () => { throw Object.assign(new Error('command failed'), { stderr: '[failover] groq:model HTTP413: payload too large', code: 1, killed: true }); } });
  await assert.rejects(fail(message), /code=1, killed=true.*groq:model HTTP413: payload too large/);
});

test('Discord denies are cached across runs for 24 hours, then rechecked and cleared on recovery', async t => {
  const x = setup(t); const discordDenied = {};
  fs.mkdirSync(path.join(x.dir, '.claude')); fs.writeFileSync(path.join(x.dir, '.claude', 'orgiast-discord-bot-token.txt'), 'test');
  let recover = false; const calls = [];
  const opts = { sources: ['discord'], home: x.dir, since: { discord: now - 1000 }, until: now, discordDenied, log: () => {},
    listChannels: async () => ['good', 'forbidden', 'missing'].map(id => ({ id, type: 0 })),
    discordFetch: async ({ channelId }) => {
      calls.push(channelId);
      if (channelId !== 'good' && !recover) throw Object.assign(new Error('denied'), { status: channelId === 'missing' ? 404 : 403 });
      return { messages: [] };
    },
  };
  assert.equal((await collectMessages(opts)).stats.discordChannels.denied, 2);
  assert.equal((await collectMessages({ ...opts, until: now + 23 * 3600000 })).stats.discordChannels.cached, 2);
  assert.deepEqual(calls, ['good', 'forbidden', 'missing', 'good']);
  recover = true;
  assert.equal((await collectMessages({ ...opts, until: now + 24 * 3600000 })).stats.discordChannels.readable, 3);
  assert.deepEqual(discordDenied, {});
});

test('denied-channel state persists despite collection failure and survives cursor writes; dry-run leaves it unchanged', async t => {
  const x = setup(t);
  x.deps.collect = async ({ discordDenied }) => {
    discordDenied.blocked = { status: 403, retryAt: now + 24 * 3600000 };
    throw new Error('source unavailable');
  };
  await assert.rejects(x.run(), /source unavailable/);
  const stateFile = path.join(x.options.stateDir, 'state.json');
  const before = fs.readFileSync(stateFile, 'utf8');
  assert.equal(JSON.parse(before).discordDenied.blocked.status, 403);
  x.options.dryRun = true;
  x.deps.collect = async ({ discordDenied }) => { delete discordDenied.blocked; return { messages: [], stats: {} }; };
  await x.run(); assert.equal(fs.readFileSync(stateFile, 'utf8'), before);
  x.options.dryRun = false;
  x.deps.collect = async () => ({ messages: [], stats: {} });
  await x.run(); assert.equal(JSON.parse(fs.readFileSync(stateFile)).discordDenied.blocked.status, 403);
});

test('schedule LLM pins Gemini with fallback and budgets all provider deadlines before child kill', async () => {
  const llm = makeLlm({ home: '/tmp', execute: async (_, args, options) => {
    assert.equal(args[args.indexOf('--provider') + 1], 'gemini');
    assert.ok(args.includes('--prefer-provider'));
    assert.ok(!args.includes('--no-fallback'));
    assert.equal(args[args.indexOf('--per-provider-timeout-ms') + 1], '45000');
    assert.ok(options.timeout > 10 * 45000);
    return { stdout: '[]' };
  } });
  assert.equal(await llm(message), '[]');
});

test('schedule CLI can restore automatic extraction routing and override provider budget', async () => {
  const options = parseArgs(['--llm-provider', 'auto', '--per-provider-timeout-ms', '75']);
  assert.deepEqual(options, { llmProvider: 'auto', perProviderTimeoutMs: 75 });
  const llm = makeLlm({ ...options, home: '/tmp', execute: async (_, args, execOptions) => {
    assert.ok(!args.includes('--prefer-provider'));
    assert.equal(args[args.indexOf('--category') + 1], 'extraction');
    assert.equal(args[args.indexOf('--per-provider-timeout-ms') + 1], '75');
    assert.ok(execOptions.timeout > 10 * 75);
    return { stdout: '[]' };
  } });
  await llm(message);
  for (const args of [['--llm-provider'], ['--llm-provider', 'wrong'], ['--per-provider-timeout-ms', '0']]) assert.throws(() => parseArgs(args));
});
