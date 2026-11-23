import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { collect, messageKey, keywordClassification, parseClassification, makeClassifier, schedulePlan, changeSchedule, act, remind, run, save, DEFAULT_WATCH } from './catch-and-act.mjs';
import { createCalendarClient } from './schedule-sync.mjs';
import { createGatewayServer } from './beeper-gateway.mjs';
import { downloadAttachment } from './beeper-api.mjs';

const now = Date.parse('2026-11-23T17:59:00+09:00');
const msg = (extra = {}) => ({ channel: 'line:chat1', id: 'm1', ts: new Date(now - 1000).toISOString(), sender: '担当者', text: '', attachments: [], ...extra });
function setup(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'catch-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, '.claude/catch-and-act');
  const asks = new Map(), calls = [];
  const inbox = async o => { calls.push(o); if (!asks.has(o.dedupeKey)) asks.set(o.dedupeKey, { id: `inbox-${asks.size}`, status: 'open' }); return asks.get(o.dedupeKey); };
  return { home, root, asks, calls, inbox, watch: DEFAULT_WATCH, now, calendar: async () => { throw new Error('calendar unexpected'); } };
}
const classification = extra => ({ kind: 'schedule_change', title: '定例会議', date: '2026-11-25', start: null, end: null, deadline: null, ...extra });

test('keyword fallback distinguishes all categories and uses JST explicit deadlines', () => {
  assert.equal(keywordClassification(msg({ text: '11/25に会議お願いします' })).kind, 'schedule_change');
  assert.equal(keywordClassification(msg({ attachments: [{ type: 'img', mimeType: 'image/jpeg' }] })).kind, 'submission');
  assert.equal(keywordClassification(msg({ text: 'いかがですか？' })).kind, 'reply_needed');
  assert.equal(keywordClassification(msg({ text: '資料作成をお願いします' })).kind, 'request');
  assert.equal(keywordClassification(msg({ text: '承知しました' })).kind, 'none');
  assert.equal(keywordClassification(msg({ text: '明日午後3時までにお願いします' })).deadline, '2026-11-24T15:00:00+09:00');
  assert.equal(keywordClassification(msg({ text: '2/30の予定' })).date, null);
});

test('classification rejects unknown kinds and timezone-less deadlines', () => {
  assert.throws(() => parseClassification('{"kind":"send"}'));
  assert.throws(() => parseClassification({ kind: 'request', deadline: '2026-11-23T20:00:00' }));
  assert.equal(parseClassification('```json\n{"kind":"none","deadline":null}\n```').kind, 'none');
});

test('classifier uses exact GLM → DeepSeek → Groq chain, disables implicit fallback and then keywords', async t => {
  const { home } = setup(t), providers = [];
  const classify = makeClassifier({ home, execute: async (cmd, args, options) => {
    providers.push(args[args.indexOf('--provider') + 1]);
    assert.ok(args.includes('--no-fallback')); assert.ok(args.includes('--prefer-provider'));
    assert.ok(options.timeout <= 22000); assert.equal(options.windowsHide, true);
    throw new Error('unavailable');
  } });
  assert.equal((await classify(msg({ text: '写真です' }))).kind, 'submission');
  assert.deepEqual(providers, ['glm', 'deepseek', 'groq']);
  assert.equal((await classify(msg({ text: 'お願いします' }))).method, 'keywords');
  assert.equal(providers.length, 3);
});

test('cursor is read-only with non-Claude model; unavailable cursor falls back to GLM', async t => {
  const { home } = setup(t), calls = [];
  const classify = makeClassifier({ home, classifier: 'cursor', execute: async (cmd, args) => {
    calls.push(cmd);
    if (cmd === 'cursor-agent') { assert.ok(args.includes('--mode=ask')); assert.ok(args.includes('gpt-5')); throw new Error('blocked'); }
    return { stdout: '{"kind":"request","deadline":null}' };
  } });
  assert.equal((await classify(msg())).method, 'glm'); assert.equal(calls.length, 2);
});

test('photo is never discarded by AI and automated mail never calls AI', async t => {
  const { home } = setup(t); let count = 0;
  const classify = makeClassifier({ home, execute: async () => { count++; return { stdout: '{"kind":"none","deadline":null}' }; } });
  assert.equal((await classify(msg({ chat: '株式会社ラハイナ', attachments: [{ type: 'image' }] }))).kind, 'submission');
  assert.equal((await classify(msg({ automated: true }))).kind, 'none'); assert.equal(count, 1);
});

test('collect paginates both mailboxes and every LINE chat including muted/archive; own messages excluded', async () => {
  const state = { sources: {}, items: {} }, calls = [], checkpoint = () => {};
  const deps = { state, checkpoint, until: now, since: now - 3600000,
    gmail: async ({ user, pageToken }) => ({ messages: [{ id: pageToken || 'same-id', internalDate: String(now - 1000), subject: 'x', body: 'y', labels: [] }], nextPageToken: pageToken ? null : 'page2' }),
    accounts: async () => [{ accountID: 'a', network: 'LINE' }],
    chats: async ({ cursor }) => ({ items: [{ id: cursor || 'chat1', accountID: 'a', title: '業務連絡、引き継ぎ', isMuted: true, isArchived: true }], hasMore: !cursor, oldestCursor: 'chat2' }),
    messages: async (id, { cursor }) => { calls.push([id, cursor]); return { items: [{ id: cursor || 'same-id', timestamp: new Date(now - 1000).toISOString(), text: '新着' }, { id: 'self', isSender: true, timestamp: new Date(now - 1000).toISOString() }], hasMore: !cursor, oldestCursor: 'old' }; } };
  const result = await collect(deps);
  assert.deepEqual(result.failures, []); assert.equal(calls.length, 4);
  assert.equal(Object.keys(state.items).length, 8);
  assert.equal(Object.keys(state.sources).length, 4);
  await collect(deps); assert.equal(Object.keys(state.items).length, 8);
});

test('failed Gmail page and LINE chat keep their old cursor, successful sources still advance', async () => {
  const state = { sources: {}, items: {} };
  const result = await collect({ state, checkpoint: () => {}, until: now, since: now - 3600000,
    gmail: async ({ user, pageToken }) => {
      if (user.startsWith('kim') && pageToken) throw new Error('429');
      return { messages: [{ id: 'saved', internalDate: String(now - 1000) }], nextPageToken: user.startsWith('kim') ? 'more' : null };
    }, accounts: async () => [{ accountID: 'a', network: 'line' }],
    chats: async () => ({ items: [{ id: 'c', accountID: 'a' }] }), messages: async () => { throw new Error('offline'); } });
  assert.equal(state.sources['gmail:kim@orgiast.jp'], undefined);
  assert.equal(state.sources['gmail:seisaku-team@orgiast.jp'], now);
  assert.equal(state.sources['line:c'], undefined);
  assert.ok(state.items['gmail:kim@orgiast.jp:saved']); assert.equal(result.failures.length, 2);
});

test('repeated pagination cursor is an error rather than silently skipping messages', async () => {
  const state = { sources: {}, items: {} };
  const result = await collect({ state, checkpoint: () => {}, until: now, since: now - 3600000, gmail: async () => ({ messages: [] }),
    accounts: async () => [{ accountID: 'a', network: 'LINE' }], chats: async () => ({ items: [], hasMore: true, oldestCursor: 'same' }) });
  assert.equal(result.failures.length, 1); assert.equal(result.failures[0].source, 'line');
});

test('watch matches time-only KAZUAKII reply, rejects expired/wrong-sender/unsubstantiated dates', () => {
  const m = msg({ sender: 'KAZUAKII', text: '午後3時でお願いします' });
  const plan = schedulePlan(m, classification({ date: null, title: '' }), DEFAULT_WATCH, now);
  assert.equal(plan.eventId, DEFAULT_WATCH.events[0].eventId); assert.equal(plan.start, '2026-11-25T15:00:00+09:00');
  assert.equal(schedulePlan(m, classification({ date: '2026-11-23', start: '2026-11-23T15:00:00+09:00' }), DEFAULT_WATCH, now).start, '2026-11-25T15:00:00+09:00');
  assert.equal(schedulePlan({ ...m, sender: 'other' }, classification({ date: null }), DEFAULT_WATCH, now), null);
  assert.equal(schedulePlan(m, classification({ date: null }), DEFAULT_WATCH, now + 5 * 86400000), null);
  assert.equal(schedulePlan(msg({ text: '会議をお願いします' }), classification({ start: '2026-11-25T15:00:00+09:00' }), {}, now), null);
});

test('calendar creates tentative free all-day event and updates it to timed without adding guests', async () => {
  const writes = [];
  const m = msg({ text: '11/25 定例会議 時間未定' }), c = classification();
  const calendar = { list: async () => [], create: async body => { writes.push(body); return { id: body.id }; } };
  const first = await changeSchedule(m, c, { watch: {}, now, calendar, key: messageKey(m) });
  assert.equal(first.action, 'calendar_created'); assert.equal(writes[0].transparency, 'transparent');
  assert.equal(writes[0].start.date, '2026-11-25'); assert.equal(writes[0].end.date, '2026-11-26');
  assert.match(writes[0].summary, /^【仮】/); assert.equal('attendees' in writes[0], false);
  const old = { ...writes[0], id: first.eventId };
  calendar.list = async () => [old]; calendar.reschedule = async (id, body) => { assert.equal(id, old.id); writes.push(body); return { id }; };
  await changeSchedule(msg({ id: 'm2', ts: new Date(now).toISOString(), text: '11/25 定例会議は15時です' }), classification({ start: '2026-11-25T15:00:00+09:00' }), { watch: {}, now, calendar, key: 'second' });
  assert.equal(writes[1].start.date, null); assert.equal(writes[1].start.dateTime, '2026-11-25T15:00:00+09:00');
  assert.equal(writes[1].transparency, 'opaque'); assert.equal(writes[1].summary, '定例会議');
});

test('existing original-date event moves, ambiguous matches ask, older retried update cannot reverse newer update', async () => {
  const m = msg({ text: '11/24の定例会議を11/25 15時に変更' }), c = classification({ originalDate: '2026-11-24', start: '2026-11-25T15:00:00+09:00' });
  let patches = 0;
  const event = { id: 'old', summary: '定例会議', start: { date: '2026-11-24' } };
  const calendar = { list: async start => start.startsWith('2026-11-24') ? [event] : [], reschedule: async id => { patches++; return { id }; } };
  assert.equal((await changeSchedule(m, c, { watch: {}, now, calendar, key: 'key' })).eventId, 'old');
  assert.equal(patches, 1);
  calendar.list = async () => [event, { ...event, id: 'other' }];
  assert.equal((await changeSchedule(m, c, { watch: {}, now, calendar, key: 'key' })).pending, true);
  event.extendedProperties = { private: { catchReceivedAt: new Date(now).toISOString() } };
  calendar.list = async () => [event];
  assert.equal((await changeSchedule(m, c, { watch: {}, now, calendar, key: 'key' })).action, 'calendar_already_applied'); assert.equal(patches, 1);
});

test('calendar API patch strips attendee/notification injection and explicitly disables update mail', async () => {
  const client = createCalendarClient('token', async (url, options) => {
    assert.equal(new URL(url).searchParams.get('sendUpdates'), 'none');
    assert.equal(options.method, 'PATCH');
    const body = JSON.parse(options.body); assert.deepEqual(Object.keys(body), ['summary', 'start']);
    return new Response('{"id":"event"}');
  });
  await client.reschedule('event', { summary: '予定', start: { dateTime: '2026-11-25T15:00:00+09:00', date: null }, attendees: [{ email: 'outsider@example.org' }], sendUpdates: 'all' });
});

test('Lahaina submission saves photos, complete caption/deadline ask; daily-send approval never publishes', async t => {
  const d = setup(t), m = msg({ chat: '株式会社ラハイナ', attachments: [{ type: 'image', srcURL: 'mxc://host/photo' }], text: '本日の写真です' });
  save(path.join(d.home, '.claude/lahaina-daily-post/calendar.json'), [{ date: '2026-11-23', theme: 'ゆっくり休む日' }]);
  save(path.join(d.home, '.claude/lahaina-daily-post/standing-approval.json'), { approved: true });
  let downloads = 0;
  const item = { message: m, classification: classification({ kind: 'submission' }) };
  const result = await act(item, messageKey(m), { ...d, download: async () => { downloads++; return Buffer.from('image bytes'); } });
  assert.equal(result.status, 'pending'); assert.equal(result.deadline, '2026-11-23T20:00:00+09:00');
  const queue = JSON.parse(fs.readFileSync(result.queueFile)); assert.equal(queue.status, 'awaiting_approval');
  assert.equal(queue.theme, 'ゆっくり休む日'); assert.ok(fs.existsSync(queue.photos[0]));
  assert.ok(d.calls[0].text.includes(queue.caption)); assert.ok(d.calls[0].text.includes(queue.photos[0]));
  await act(item, messageKey(m), { ...d, download: async () => { downloads++; } });
  assert.equal(downloads, 1); assert.equal(d.asks.size, 1);
});

test('failed attachment is retained and recovered on retry, never marked completed', async t => {
  const d = setup(t), m = msg({ chat: '株式会社ラハイナ', attachments: [{ type: 'image' }] });
  const item = { message: m, classification: classification({ kind: 'submission' }) };
  const failed = await act(item, messageKey(m), { ...d, download: async () => { throw new Error('404 old gateway'); } });
  assert.equal(failed.status, 'retry'); assert.equal(JSON.parse(fs.readFileSync(failed.queueFile)).photos.length, 0);
  const recovered = await act(item, messageKey(m), { ...d, download: async () => Buffer.from('recovered') });
  assert.equal(recovered.status, 'pending'); assert.equal(JSON.parse(fs.readFileSync(recovered.queueFile)).photos.length, 1);
});

test('2h and overdue urgent reminders are once each; an approval answer is not proof of posting', async t => {
  const d = setup(t), key = 'k', queueFile = path.join(d.root, 'insta-queue/q.json');
  save(queueFile, { status: 'awaiting_approval' });
  const state = { items: { [key]: { message: msg(), status: 'pending', queueFile, inboxId: 'i', deadline: '2026-11-23T20:00:00+09:00', notifyText: 'caption' } } };
  const deps = { ...d, checkpoint: () => {}, readItem: () => ({ status: 'answered' }) };
  assert.equal(await remind(state, deps), 0);
  assert.equal(await remind(state, { ...deps, now: now + 60000 }), 1);
  assert.equal(await remind(state, { ...deps, now: now + 120000 }), 0);
  assert.equal(await remind(state, { ...deps, now: now + 3 * 3600000 }), 1);
  assert.equal(d.calls[0].urgent, true);
  save(queueFile, { status: 'published' }); await remind(state, deps); assert.equal(state.items[key].status, 'done');
});

test('reply and request create only inbox records; inbox forwarding failures propagate for retry', async t => {
  const d = setup(t);
  const reply = { message: msg({ sender: 'person@example.net' }), classification: classification({ kind: 'reply_needed', draft: '確認いたします。' }) };
  assert.equal((await act(reply, 'reply', d)).action, 'reply_drafted'); assert.equal(d.calls[0].kind, 'ask');
  assert.match(d.calls[0].text, /確認いたします/);
  assert.equal((await act({ ...reply, classification: classification({ kind: 'request' }) }, 'request', d)).status, 'pending'); assert.equal(d.calls[1].kind, 'info');
  await assert.rejects(act(reply, 'error', { ...d, inbox: async () => ({ id: 'saved', forwardError: 'offline' }) }), /delivery failed/);
});

test('unknown schedule date asks without requiring a calendar connection', async t => {
  const d = setup(t);
  const result = await act({ message: msg({ text: '会議の日程を変更したいです' }), classification: classification({ date: null }) }, 'unknown', d);
  assert.equal(result.action, 'schedule_ask'); assert.equal(d.calls[0].kind, 'ask');
});

test('bulk automatic FYIs do not consume the per-run human action budget', async t => {
  const d = setup(t), seen = [];
  const result = await run({ home: d.home, now, maxItems: 1 }, { ...d, readItem: () => null,
    collect: async ({ state }) => {
      for (let i = 0; i < 100; i++) state.items[`auto${i}`] = { message: msg({ id: String(i), automated: true, text: '自動通知です' }), status: 'new' };
      state.items.human = { message: msg({ text: 'お返事ください' }), status: 'new' }; return { counts: {}, failures: [] };
    }, classify: async m => { seen.push(m.text); return classification({ kind: 'reply_needed' }); } });
  assert.equal(result.deferred, 0); assert.equal(result.classified.none, 100); assert.deepEqual(seen, ['お返事ください']);
});

test('run checkpoints classification, retries side effects without reclassification, dedupes replay, one sanitized log per run', async t => {
  const d = setup(t); let classifications = 0, attempts = 0;
  const m = msg({ text: '秘密の連絡内容' }), key = messageKey(m);
  const deps = { ...d, readItem: () => ({ status: 'open' }),
    collect: async ({ state, checkpoint }) => { state.items[key] ||= { message: m, status: 'new' }; checkpoint(); return { counts: { line: 1 }, failures: [] }; },
    classify: async () => { classifications++; return classification({ kind: 'reply_needed' }); },
    inbox: async o => { if (attempts++ === 0) throw new Error('temporary'); return d.inbox(o); } };
  assert.equal((await run({ home: d.home, now }, deps)).status, 'error');
  assert.equal((await run({ home: d.home, now }, deps)).status, 'ok');
  assert.equal((await run({ home: d.home, now }, deps)).processed, 0); assert.equal(classifications, 1);
  const log = fs.readFileSync(path.join(d.home, '.claude/logs/catch-and-act.log'), 'utf8');
  assert.equal(log.trim().split('\n').length, 3); assert.ok(!log.includes(m.text));
});

test('run protects live lock and bounds work while leaving backlog durable', async t => {
  const d = setup(t), lock = path.join(d.root, '.lock'); fs.mkdirSync(d.root, { recursive: true }); fs.writeFileSync(lock, String(process.pid));
  await assert.rejects(run({ home: d.home, now }), /already running/); fs.unlinkSync(lock);
  const result = await run({ home: d.home, now, maxItems: 1 }, { ...d, readItem: () => null,
    collect: async ({ state }) => { for (const id of ['1', '2']) state.items[id] = { message: msg({ id }), status: 'new' }; return { counts: {}, failures: [] }; },
    classify: async () => ({ kind: 'none', method: 'keywords' }) });
  assert.equal(result.processed, 1); assert.equal(result.deferred, 1); assert.equal(result.keywordFallback, 1);
});

test('gateway downloads only Matrix assets using trusted upstream URL; binary survives read-only gateway', async t => {
  const d = setup(t), calls = [], bytes = Buffer.from([0, 255, 0, 128, 13]);
  const server = createGatewayServer({ gatewayToken: 'gateway-test', getUpstreamToken: () => 'upstream-test', readOnly: true, logPath: path.join(d.root, 'gateway.log'), fetchImpl: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/download')) return new Response(JSON.stringify({ srcURL: 'file:///beeper-cache/photo.jpg' }));
    return new Response(bytes, { headers: { 'content-type': 'image/jpeg' } });
  } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`, configFile = path.join(d.home, 'gateway-config.json');
  save(configFile, { base, token: 'gateway-test' });
  const result = await downloadAttachment({ srcURL: 'mxc://host/photo' }, { env: { BEEPER_GATEWAY_CONFIG: configFile } });
  assert.deepEqual(result, bytes); assert.equal(calls.length, 2);
  for (const url of ['file:///C:/private', 'https://evil.example/a', 'mxc://host/photo?url=file:///x']) {
    const res = await fetch(base + '/gateway/attachment', { method: 'POST', headers: { Authorization: 'Bearer gateway-test' }, body: JSON.stringify({ url }) });
    assert.equal(res.status, 400);
  }
  assert.equal(calls.length, 2);
  const log = fs.readFileSync(path.join(d.root, 'gateway.log'), 'utf8'); assert.ok(!log.includes('upstream-test')); assert.ok(!log.includes('photo.jpg'));
});
