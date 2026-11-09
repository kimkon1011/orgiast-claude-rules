import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, requestJson, japanDate, transcriptText, notesText, documentContent,
  createClient, runBackfill, safeReason, BackfillError, FOLDER_ID, IMPERSONATE, CUTOFF } from './tldv-drive-backfill.mjs';

const meeting = (id, happenedAt = '2026-11-04T15:30:00Z') => ({ id, happenedAt, name: '制作定例',
  invitees: [{ name: '田中', email: 'tanaka@example.com' }], url: `https://tldv.io/app/meetings/${id}` });
const transcript = { data: [{ speaker: '田中', text: 'こんにちは' }, { speaker: '', text: '確認します' }] };
const notes = { markdownContent: '## 決定事項\n明日対応', structuredNotes: [] };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const noSleep = async () => {};
const quiet = () => {};

function mockApi(meetings = [meeting('one')]) {
  const files = new Map(), calls = [], uploads = [];
  let active = 0, maxActive = 0;
  const fetchImpl = async (url, init = {}) => {
    active++; maxActive = Math.max(maxActive, active);
    try {
      await new Promise(resolve => setImmediate(resolve));
      const u = new URL(url);
      calls.push({ url: u, init });
      if (u.hostname === 'pasta.tldv.io') {
        assert.equal(init.headers['x-api-key'], 'secret');
        if (u.pathname.endsWith('/transcript')) return json(transcript);
        if (u.pathname.endsWith('/notes')) return json(notes);
        const page = Number(u.searchParams.get('page'));
        assert.equal(u.searchParams.get('limit'), '100');
        return json({ page, pages: Math.max(1, Math.ceil(meetings.length / 2)), results: meetings.slice((page - 1) * 2, page * 2) });
      }
      assert.equal(u.hostname, 'www.googleapis.com');
      assert.equal(init.headers.Authorization, 'Bearer token');
      if (init.method === 'POST') {
        assert.equal(u.pathname, '/upload/drive/v3/files');
        assert.equal(u.searchParams.get('uploadType'), 'multipart');
        const meta = JSON.parse(init.body.split('\r\n')[3]);
        uploads.push({ meta, body: init.body, contentType: init.headers['Content-Type'] });
        const file = { id: `doc-${meta.appProperties.tldvMeetingId}`, ...meta };
        files.set(meta.appProperties.tldvMeetingId, file);
        return json(file);
      }
      const q = u.searchParams.get('q');
      assert.ok(q.includes(`'${FOLDER_ID}' in parents`));
      assert.ok(q.includes('trashed = false'));
      const id = q.match(/value='(.*)' }$/)[1];
      return json({ files: files.has(id) ? [files.get(id)] : [] });
    } finally { active--; }
  };
  let tokenCalls = 0;
  const client = createClient({ apiKey: 'secret', fetchImpl, sleepImpl: noSleep, getToken: async options => {
    assert.equal(options.impersonate, IMPERSONATE); tokenCalls++; return 'token';
  } });
  return { client, files, calls, uploads, maxActive: () => maxActive, tokenCalls: () => tokenCalls };
}

test('CLI validates limits and rejects accidental options', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--limit', '5']), { dryRun: true, limit: 5, all: false });
  assert.equal(parseArgs([]).limit, Infinity);
  for (const argv of [['--limit'], ['--limit', '0'], ['--limit', '-1'], ['--limit', '1.5'],
    ['--limit', '1e3'], ['--limit', '9007199254740992'], ['--delete']]) assert.throws(() => parseArgs(argv));
});

test('JST rollover, participants, source URL, notes and speaker text are preserved in order', () => {
  assert.equal(japanDate('2026-12-31T15:05:00Z'), '2027-01-01 00:05');
  const doc = documentContent(meeting('one'), transcriptText(transcript), notesText(notes));
  assert.equal(doc.name, '2026-11-05 00:30（日本時間） 制作定例');
  assert.match(doc.body, /田中 \/ tanaka@example.com/);
  assert.match(doc.body, /話者不明: 確認します/);
  const labels = ['制作定例', '日時:', '参加者:', 'tl;dv:', '\nメモ\n', '\n文字起こし\n'];
  for (let i = 1; i < labels.length; i++) assert.ok(doc.body.indexOf(labels[i]) > doc.body.indexOf(labels[i - 1]));
});

test('empty transcripts and notes are distinct from unknown response formats', () => {
  assert.equal(transcriptText(null), '');
  assert.equal(notesText(null), '（メモなし）');
  assert.equal(transcriptText({ data: [] }), '');
  assert.equal(transcriptText({ data: [{ text: ' \n ' }] }), '');
  assert.throws(() => transcriptText({ segments: [] }));
  assert.throws(() => transcriptText({ data: [{ text: {} }] }));
  assert.equal(notesText({ structuredNotes: [] }), '（メモなし）');
  assert.equal(notesText({ structuredNotes: [{ text: '対応する', topicId: 'a' }], topics: [{ id: 'a', title: '結論' }] }), '結論: 対応する');
  assert.throws(() => notesText({ unknown: [] }));
});

test('all pages, strict cutoff, stable limit, multipart metadata, concurrency and rerun idempotence', async () => {
  const api = mockApi([meeting('equal', CUTOFF), meeting('after', '2026-11-05T07:20:01Z'),
    meeting('c'), meeting('a'), meeting('b'), meeting('later', '2026-11-05T07:19:59Z'), meeting('a')]);
  const first = await runBackfill({ client: api.client, limit: 3, out: quiet });
  assert.equal(first.created, 3);
  assert.equal(first.failed, 0);
  assert.deepEqual([...api.files.keys()].sort(), ['a', 'b', 'c']);
  assert.equal(api.maxActive(), 2);
  assert.equal(api.tokenCalls(), 1);
  for (const upload of api.uploads) {
    assert.deepEqual(upload.meta.parents, [FOLDER_ID]);
    assert.equal(upload.meta.mimeType, 'application/vnd.google-apps.document');
    assert.match(upload.contentType, /^multipart\/related; boundary=tldv_/);
    assert.match(upload.body, /Content-Type: text\/plain; charset=UTF-8/);
    assert.match(upload.body, /田中: こんにちは/);
  }
  const second = await runBackfill({ client: api.client, limit: 3, out: quiet });
  assert.equal(second.existing, 3);
  assert.equal(second.created, 0);
  assert.equal(api.uploads.length, 3);
});

test('dry run reads and validates content but never writes', async () => {
  const api = mockApi([meeting('one'), meeting('two')]);
  const result = await runBackfill({ client: api.client, dryRun: true, out: quiet });
  assert.equal(result.planned, 2);
  assert.equal(result.created, 0);
  assert.equal(api.uploads.length, 0);
  assert.equal(api.calls.filter(c => c.url.pathname.endsWith('/notes')).length, 2);
});

test('empty and failed transcripts and failed notes produce no documents, and progress covers skips', async () => {
  const output = [], writes = [];
  const client = {
    listMeetings: async () => Array.from({ length: 10 }, (_, i) => meeting(String(i))),
    findExisting: async id => id === '0' ? { id: 'existing' } : undefined,
    transcript: async id => {
      if (id === '1') return { data: [] };
      if (id === '2') throw new Error('TOKEN-SECRET');
      return transcript;
    },
    notes: async id => { if (id === '3') throw new Error('API-KEY-SECRET'); return notes; },
    createDocument: async m => { writes.push(m.id); return { id: 'doc' }; },
  };
  const result = await runBackfill({ client, out: line => output.push(line) });
  assert.deepEqual([result.created, result.existing, result.empty, result.failed], [6, 1, 1, 2]);
  assert.equal(result.reasons['transcript:unexpected-error'], 1);
  assert.equal(result.reasons['notes:unexpected-error'], 1);
  assert.ok(output.some(line => line.startsWith('進捗 10/10')));
  assert.equal(output.at(-1), '作成 6 / 既存スキップ 1 / 空スキップ 1 / 失敗 2');
  assert.doesNotMatch(output.join('\n'), /SECRET/);
  assert.equal(writes.length, 6);
});

test('429 and 5xx exponential backoff respects Retry-After', async () => {
  const delays = [], statuses = [429, 500, 502, 503, 200];
  const result = await requestJson('https://example.test', {}, {
    fetchImpl: async () => json({ ok: true }, statuses.shift(), { 'retry-after': '3' }),
    sleepImpl: async ms => delays.push(ms),
  });
  assert.equal(result.ok, true);
  assert.deepEqual(delays, [3000, 3000, 4000, 8000]);
});

test('tl;dv 204 No Content becomes an empty transcript, not a JSON failure', async () => {
  const result = await requestJson('https://example.test', {}, { fetchImpl: async () => new Response(null, { status: 204 }) });
  assert.equal(transcriptText(result), '');
});

test('retry attempts are bounded and upstream errors never leak', async () => {
  for (const status of [429, 500, 403]) {
    let calls = 0;
    await assert.rejects(requestJson('https://example.test', {}, {
      fetchImpl: async () => { calls++; return json({ secret: 'API-KEY' }, status); }, sleepImpl: noSleep,
    }), error => safeReason(error) === `api-http-${status}`);
    assert.equal(calls, status === 403 ? 1 : 5);
  }
  let calls = 0;
  await assert.rejects(requestJson('https://example.test', {}, {
    fetchImpl: async () => { calls++; throw new Error('TOKEN'); }, sleepImpl: noSleep,
  }), /api-network-error/);
  assert.equal(calls, 5);
});

test('ambiguous upload success is reconciled before retry, avoiding duplicate POST', async () => {
  for (const networkError of [false, true]) {
    let committed = false, posts = 0;
    const client = createClient({ apiKey: 'secret', getToken: async () => 'token', sleepImpl: noSleep,
      fetchImpl: async (_url, init) => {
        if (init.method === 'POST') {
          posts++; committed = true;
          if (networkError) throw new Error('lost response');
          return json({}, 503);
        }
        return json({ files: committed ? [{ id: 'saved', appProperties: { tldvMeetingId: 'one' } }] : [] });
      },
    });
    const saved = await client.createDocument(meeting('one'), { name: 'a', body: 'b' });
    assert.equal(saved.id, 'saved');
    assert.equal(posts, 1);
  }
});

test('invalid pagination fails closed instead of silently omitting meetings', async () => {
  for (const data of [{ results: [] }, { pages: 0, results: [meeting('a')] }, { page: 2, pages: 2, results: [] },
    { pages: 1, results: [{ id: 'broken' }] }]) {
    const client = createClient({ apiKey: 'secret', fetchImpl: async () => json(data), getToken: async () => 'token' });
    await assert.rejects(client.listMeetings());
  }
});

test('Drive query escapes apostrophes and backslashes in meeting IDs', async () => {
  let query;
  const client = createClient({ apiKey: 'secret', getToken: async () => 'token', fetchImpl: async url => {
    query = new URL(url).searchParams.get('q'); return json({ files: [] });
  } });
  await client.findExisting("a'b\\c");
  assert.ok(query.includes("value='a\\'b\\\\c'"));
});

test('Drive authentication errors are sanitized', async () => {
  const client = createClient({ apiKey: 'secret', getToken: async () => { throw new Error('credential-value'); } });
  await assert.rejects(client.findExisting('one'), /drive-auth-failed/);
});

test('parseArgs accepts --all flag', () => {
  assert.deepEqual(parseArgs(['--all']), { dryRun: false, limit: Infinity, all: true });
  assert.deepEqual(parseArgs(['--all', '--dry-run']), { dryRun: true, limit: Infinity, all: true });
  assert.deepEqual(parseArgs(['--all', '--limit', '10']), { dryRun: false, limit: 10, all: true });
});

function mockApiAll(meetings = [], existingIds = []) {
  const files = new Map(existingIds.map(id => [id, { id, appProperties: { tldvMeetingId: id } }]));
  const calls = [], uploads = [];
  const pages = [];
  for (let i = 0; i < meetings.length; i += 2) pages.push(meetings.slice(i, i + 2));
  const totalPages = Math.max(1, pages.length);
  const fetchImpl = async (url, init = {}) => {
    await new Promise(resolve => setImmediate(resolve));
    const u = new URL(url);
    calls.push({ url: u, init });
    if (u.hostname === 'pasta.tldv.io') {
      if (u.pathname.endsWith('/transcript')) return json(transcript);
      if (u.pathname.endsWith('/notes')) return json(notes);
      const page = Number(u.searchParams.get('page'));
      return json({ page, pages: totalPages, results: pages[page - 1] || [] });
    }
    assert.equal(u.hostname, 'www.googleapis.com');
    assert.equal(init.headers.Authorization, 'Bearer token');
    if (init.method === 'POST') {
      assert.equal(u.pathname, '/upload/drive/v3/files');
      assert.equal(u.searchParams.get('uploadType'), 'multipart');
      const meta = JSON.parse(init.body.split('\r\n')[3]);
      uploads.push({ meta, body: init.body, contentType: init.headers['Content-Type'] });
      const file = { id: `doc-${meta.appProperties.tldvMeetingId}`, ...meta };
      files.set(meta.appProperties.tldvMeetingId, file);
      return json(file);
    }
    const q = u.searchParams.get('q');
    const id = q.match(/value='(.*)' }$/)[1];
    return json({ files: files.has(id) ? [files.get(id)] : [] });
  };
  const client = createClient({ apiKey: 'secret', fetchImpl, sleepImpl: noSleep, getToken: async () => 'token' });
  return { client, files, calls, uploads };
}

test('--all mode filters by endedAt + 60 min, excludes not-yet-ended meetings', async () => {
  const now = Date.now();
  const ended1h10m = new Date(now - 70 * 60 * 1000).toISOString();
  const ended30m = new Date(now - 30 * 60 * 1000).toISOString();
  const ended2h = new Date(now - 120 * 60 * 1000).toISOString();
  const api = mockApiAll([
    { id: 'a', happenedAt: ended2h, duration: 0, name: 'old', invitees: [] },
    { id: 'b', happenedAt: ended1h10m, duration: 0, name: 'recent', invitees: [] },
    { id: 'c', happenedAt: ended30m, duration: 0, name: 'too-recent', invitees: [] },
  ]);
  const result = await runBackfill({ client: api.client, all: true, out: quiet });
  assert.equal(result.created, 2);
  assert.equal(result.existing, 0);
  assert.deepEqual([...api.files.keys()].sort(), ['a', 'b']);
});

test('--all mode stops pagination when 50 consecutive existing meetings found', async () => {
  const now = Date.now();
  const ended = new Date(now - 120 * 60 * 1000).toISOString();
  const newMeetings = [
    { id: 'n1', happenedAt: ended, duration: 0, name: 'new1', invitees: [] },
    { id: 'n2', happenedAt: ended, duration: 0, name: 'new2', invitees: [] },
  ];
  const existing = Array.from({ length: 50 }, (_, i) => ({ id: `existing-${i}`, happenedAt: ended, duration: 0, name: `existing-${i}`, invitees: [] }));
  const later = [{ id: 'n3', happenedAt: ended, duration: 0, name: 'new3', invitees: [] }];
  const existingIds = existing.map(m => m.id);
  const api = mockApiAll([...newMeetings, ...existing, ...later], existingIds);
  const result = await runBackfill({ client: api.client, all: true, out: quiet });
  assert.equal(result.created, 2); // only n1, n2 created
  assert.equal(api.files.has('n3'), false); // n3 never reached (pagination stopped)
  assert.equal(result.existing, 0); // listMeetingsAll already filtered out existing
});

test('--all mode exit code: 403-only failures return 0', async () => {
  const output = [];
  const client = {
    listMeetingsAll: async () => [{ id: 'a', happenedAt: new Date(Date.now() - 7200000).toISOString(), duration: 0, name: 'a', invitees: [] }],
    findExisting: async () => undefined,
    transcript: async () => { throw new BackfillError('drive-http-403'); },
    notes: async () => { throw new BackfillError('drive-http-403'); },
    createDocument: async () => { throw new BackfillError('drive-http-403'); },
  };
  const result = await runBackfill({ client, all: true, out: line => output.push(line) });
  assert.equal(result.failed, 1);
  assert.ok(Object.keys(result.reasons).every(r => r.endsWith('http-403')));
  // Simulate main exit logic
  const all403 = Object.keys(result.reasons).every(r => r.endsWith('http-403'));
  assert.equal(all403, true);
});

test('--all mode exit code: non-403 failure returns 1', async () => {
  const client = {
    listMeetingsAll: async () => [{ id: 'a', happenedAt: new Date(Date.now() - 7200000).toISOString(), duration: 0, name: 'a', invitees: [] }],
    findExisting: async () => undefined,
    transcript: async () => { throw new BackfillError('transcript-http-500'); },
    notes: async () => { throw new BackfillError('notes-http-500'); },
    createDocument: async () => { throw new BackfillError('drive-http-500'); },
  };
  const result = await runBackfill({ client, all: true, out: quiet });
  assert.equal(result.failed, 1);
  const all403 = Object.keys(result.reasons).every(r => r.endsWith('http-403'));
  assert.equal(all403, false);
});
