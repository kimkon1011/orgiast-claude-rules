import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { maskDigits, attachmentPaths, toJst, jstToIso, buildRows, dedupe, cursorFrom, HEADERS, INITIAL_CURSOR, TAB, main, fetchMessages } from './line-log-export.mjs';

const message = (id, time = '2026-10-29T15:02:03.123Z') => ({ external_message_id: id, received_at: time,
  subject: 'LINE: グループ123456789012', external_thread_id: 'thread', sender_display_name: '人1234-5678-9012',
  direction: 'inbound', body: '=123456789012', attachments: [{ url: 'line-media/x.jpg' }] });

test('mask exact twelve digits and separated forms, preserving boundaries', () => {
  for (const [input, expected] of [
    ['123456789012', '********9012'], ['a123456789012b', 'a********9012b'],
    ['1234-5678-9012 1234 5678 9012', '****-****-9012 **** **** 9012'],
    ['1234567890123 12345678901', '1234567890123 12345678901'],
    ['01234-5678-9012 / 1234 5678 90123', '01234-5678-9012 / 1234 5678 90123'],
    ['１２３４５６７８９０１２', '********９０１２'], [null, ''],
  ]) assert.equal(maskDigits(input), expected);
});
test('attachments keep storage paths only and remove queries', () => {
  assert.equal(attachmentPaths([
    ...['sign', 'public', 'authenticated'].map(mode => ({ url: `https://example.test/storage/v1/object/${mode}/line-media/x.jpg?token=secret` })),
    { url: 'http://example.test/private?token=secret' }, { url: 'line-media/y?token=secret' }, {}, null,
  ]), 'line-media/x.jpg\nline-media/x.jpg\nline-media/x.jpg\nline-media/y');
  assert.equal(attachmentPaths(null), '');
});
test('JST conversion and maximum cursor including empty sheet', () => {
  assert.equal(toJst('2026-10-29T15:02:03Z'), '2026-10-30 00:02:03');
  assert.equal(jstToIso('2026-10-30 00:02:03'), '2026-10-29T15:02:03.000Z');
  assert.equal(cursorFrom([]), INITIAL_CURSOR);
  assert.equal(cursorFrom([HEADERS]), INITIAL_CURSOR);
  assert.equal(cursorFrom([['2026-10-30 00:02:03'], ['2026-10-29 23:59:59']]), '2026-10-29T15:02:03.000Z');
  assert.throws(() => jstToIso('2026-02-30 00:00:00'), /timestamp/);
});
test('dedupe sheet and batch IDs; row column order, text and direction', () => {
  const old = buildRows([message('old')]);
  assert.deepEqual(buildRows([message('old'), message('new'), message('new')], old), [
    ['2026-10-30 00:02:03', 'グループ********9012', 'thread', '人****-****-9012', '受信', '=********9012', 'line-media/x.jpg', 'new'],
  ]);
  assert.equal(buildRows([{ ...message('x'), direction: 'outbound', body: 'a'.repeat(45001) }])[0][5].length, 45000);
  assert.equal(buildRows([{ ...message('x'), direction: 'outbound' }])[0][4], '送信');
  assert.equal(buildRows([{ ...message('x'), direction: 'other' }])[0][4], 'other');
  assert.throws(() => dedupe([{}]), /external_message_id/);
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'line-log-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const envFile = path.join(home, 'test.env');
  fs.writeFileSync(envFile, 'NEXT_PUBLIC_SUPABASE_URL=https://supabase.example.test\nSUPABASE_SERVICE_ROLE_KEY=test-secret\n');
  const rows = [], outputs = [], calls = [], driveCalls = [], batches = [];
  let messages = [message('one')], found = true, hasTab = true;
  const deps = { home, env: { LINE_LOG_ENV_FILE: envFile, LINE_LOG_SHEET_ID_FILE: path.join(home, 'id.txt') },
    output: line => outputs.push(JSON.parse(line)),
    getToken: async options => { assert.equal(options.impersonate, 'kim@orgiast.jp'); assert.equal(options.scope, 'https://www.googleapis.com/auth/drive'); return 'fake'; },
    driveApi: async (token, url, options) => {
      driveCalls.push({ url, options });
      if (options.method === 'POST') {
        assert.equal(url, 'https://www.googleapis.com/drive/v3/files?fields=id');
        assert.deepEqual(JSON.parse(options.body), { name: 'LINE受信ログ（自動・毎時）', mimeType: 'application/vnd.google-apps.spreadsheet' });
        return { json: async () => ({ id: 'created' }) };
      }
      assert.match(new URL(url).searchParams.get('q'), /'me' in owners/);
      return { json: async () => ({ files: found ? [{ id: 'existing' }] : [] }) };
    },
    fetchImpl: async (url, options) => {
      calls.push(new URL(url));
      assert.equal(options.method, 'GET');
      assert.equal(options.headers.apikey, 'test-secret');
      assert.equal(options.headers.Authorization, 'Bearer test-secret');
      const params = new URL(url).searchParams;
      assert.equal(params.get('channel'), 'eq.line');
      assert.equal(params.get('order'), 'received_at.asc,external_message_id.asc');
      const filtered = messages.filter(m => Date.parse(m.received_at) >= Date.parse(params.get('received_at').slice(4)));
      const offset = Number(params.get('offset'));
      return { ok: true, json: async () => filtered.slice(offset, offset + 1000) };
    },
    sheets: {
      ensure: async (id, tab, headers) => { assert.equal(tab, TAB); assert.deepEqual(headers, HEADERS); },
      metadata: async () => ({ sheets: hasTab ? [{ properties: { title: TAB } }] : [] }),
      get: async () => rows.map(r => [...r]),
      append: async (id, range, batch) => { batches.push(batch.length); rows.push(...batch); },
    },
  };
  return { deps, home, rows, outputs, calls, driveCalls, batches,
    setMessages: value => { messages = value; }, noSheet: () => { found = false; }, noTab: () => { hasTab = false; } };
}
test('main twice appends only differences, including same-second arrivals', async t => {
  const f = fixture(t);
  assert.deepEqual(await main([], f.deps), { ok: true, sheetId: 'existing', appended: 1, totalRows: 1, latest: '2026-10-30 00:02:03' });
  f.setMessages([message('one'), message('two'), message('two')]);
  const result = await main([], f.deps);
  assert.equal(result.appended, 1);
  assert.equal(result.totalRows, 2);
  assert.equal(f.calls[1].searchParams.get('received_at'), 'gte.2026-10-29T15:02:03.000Z');
  assert.equal(f.driveCalls.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, '.claude/line-log-export-state.json'))).ok, true);
});
test('pagination and 500-row chunks; creates via Drive', async t => {
  const f = fixture(t); f.noSheet();
  f.setMessages(Array.from({ length: 1001 }, (_, i) => message(String(i))));
  assert.equal((await main([], f.deps)).appended, 1001);
  assert.deepEqual(f.calls.map(u => u.searchParams.get('offset')), ['0', '1000']);
  assert.deepEqual(f.batches, [500, 500, 1]);
  assert.equal(f.driveCalls.length, 2);
});
for (const kind of ['absent', 'existing', 'missing tab']) test(`dry-run never writes Google or ID file: ${kind}`, async t => {
  const f = fixture(t);
  if (kind === 'absent') f.noSheet();
  if (kind === 'missing tab') f.noTab();
  if (kind === 'existing') f.rows.push(...buildRows([message('one')]));
  f.deps.sheets.ensure = f.deps.sheets.append = async () => assert.fail('write in dry-run');
  const result = await main(['--dry-run'], f.deps);
  assert.equal(result.ok, true); assert.equal(result.appended, 0);
  assert.equal(fs.existsSync(f.deps.env.LINE_LOG_SHEET_ID_FILE), false);
  assert.equal(f.driveCalls.length, 1);
  assert.equal(f.outputs[0]['追記予定件数'], kind === 'existing' ? 0 : 1);
  assert.equal(f.outputs[0].cursor, kind === 'existing' ? '2026-10-29T15:02:03.000Z' : INITIAL_CURSOR);
});
test('HTTP and unexpected failures never expose response contents or credentials', async t => {
  const f = fixture(t);
  f.deps.fetchImpl = async () => ({ ok: false, status: 403, json: () => assert.fail('error body read') });
  let result = await main([], f.deps);
  assert.equal(result.error, 'Supabase GET HTTP 403');
  f.deps.sheets.get = async () => { throw new Error('test-secret private body'); };
  result = await main([], f.deps);
  assert.equal(result.error, 'Sheet read failed');
  assert.doesNotMatch(JSON.stringify(f.outputs), /test-secret|private body/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.home, '.claude/line-log-export-state.json'))).ok, false);
});
test('fetch helper throws exact HTTP error', async () => {
  await assert.rejects(fetchMessages({ url: 'https://example.test', key: 'secret', cursor: INITIAL_CURSOR,
    fetchImpl: async () => ({ ok: false, status: 500 }) }), { message: 'Supabase GET HTTP 500' });
});
