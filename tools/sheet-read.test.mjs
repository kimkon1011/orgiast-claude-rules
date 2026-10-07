import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, run, SHEETS_SCOPE } from './sheet-read.mjs';

const sheets = [
  { properties: { title: '先頭', sheetId: 0, gridProperties: { rowCount: 1000, columnCount: 26 } } },
  { properties: { title: "アイテム'リスト", sheetId: 2063065996, gridProperties: { rowCount: 900, columnCount: 30 } } },
];
function harness(values = [[['first']], [['3902', 'モニター']]]) {
  const out = [], err = [], urls = [], auth = [];
  let i = 0;
  return { out, err, urls, auth, deps: {
    stdout: (s) => out.push(s), stderr: (s) => err.push(s),
    getToken: async (options) => { auth.push(options); return 'stub-token'; },
    fetchImpl: async (url, options) => {
      urls.push(url);
      assert.equal(options.headers.Authorization, 'Bearer stub-token');
      return { ok: true, json: async () => url.includes('/values/') ? { values: values[i++] } : { sheets } };
    },
  } };
}
test('URL extracts ID and fragment/query gid, explicit selector overrides URL', () => {
  assert.equal(parseArgs(['https://docs.google.com/spreadsheets/d/abc-123/edit#gid=0']).gid, '0');
  assert.equal(parseArgs(['https://docs.google.com/spreadsheets/u/0/d/abc-123/edit?gid=42']).gid, '42');
  assert.equal(parseArgs(['https://docs.google.com/spreadsheets/d/abc-123/edit#gid=42', '--gid', '5']).gid, '5');
  const opts = parseArgs(['https://docs.google.com/spreadsheets/d/abc-123/edit#gid=42', '--tab', '先頭']);
  assert.equal(opts.id, 'abc-123'); assert.equal(opts.gid, undefined);
});
test('--tabs lists all tabs even with URL gid and requests readonly impersonation', async () => {
  const h = harness();
  assert.equal(await run(['https://docs.google.com/spreadsheets/d/abc/edit#gid=0', '--tabs', '--as', 'other@example.com'], h.deps), 0);
  assert.deepEqual(h.out, ['先頭\t0\t1000×26', "アイテム'リスト\t2063065996\t900×30"]);
  assert.match(h.urls[0], /fields=sheets.properties$/);
  assert.deepEqual(h.auth, [{ scope: SHEETS_SCOPE, impersonate: 'other@example.com' }]);
});
test('--grep searches beyond 500 rows and every tab despite output cap', async () => {
  const h = harness([Array.from({ length: 601 }, (_, i) => [i === 600 ? '3902 late' : '3902']), [['モニター']]]);
  assert.equal(await run(['abc', '--grep', '3902|モニター', '--max-rows', '1'], h.deps), 0);
  assert.equal(h.urls.length, 3);
  assert.deepEqual(h.out, ['先頭\t1\t3902', 'TRUNCATED: 602行中1行']);
});
test('late matches are not lost with default output limit', async () => {
  const h = harness([Array.from({ length: 601 }, (_, i) => [i === 600 ? '3902' : 'other']), [['モニター']]]);
  await run(['abc', '--grep', '3902|モニター'], h.deps);
  assert.deepEqual(h.out, ['先頭\t601\t3902', "アイテム'リスト\t1\tモニター"]);
});
test('--gid reads formatted TSV with quoted tab name and range', async () => {
  const h = harness([[['3902', 'line\nbreak', 'a\tb']]]);
  assert.equal(await run(['abc', '--gid', '2063065996', '--range', 'A10:Z30'], h.deps), 0);
  assert.deepEqual(h.out, ['3902\tline\\nbreak\ta\\tb']);
  assert.match(decodeURIComponent(h.urls[1]), /'アイテム''リスト'!A10:Z30\?valueRenderOption=FORMATTED_VALUE/);
  assert.equal(h.auth[0].impersonate, 'kim@orgiast.jp');
});
test('--tab grep reports absolute row numbers for range', async () => {
  const h = harness([[[], ['3902']]]);
  await run(['abc', '--tab', '先頭', '--range', 'A10:Z30', '--grep', '3902'], h.deps);
  assert.deepEqual(h.out, ['先頭\t11\t3902']); assert.equal(h.urls.length, 2);
});
test('default reads every tab; raw TSV and tabs report truncation', async () => {
  const h = harness(); await run(['abc'], h.deps); assert.equal(h.urls.length, 3);
  const raw = harness([[['a'], ['b'], ['c']]]);
  await run(['abc', '--gid', '0', '--max-rows', '2'], raw.deps);
  assert.deepEqual(raw.out, ['a', 'b', 'TRUNCATED: 3行中2行']);
  const tabs = harness(); await run(['abc', '--tabs', '--max-rows', '1'], tabs.deps);
  assert.equal(tabs.out.at(-1), 'TRUNCATED: 2行中1行');
});
test('HTTP errors include status and body; missing tabs never fall back', async () => {
  const h = harness();
  h.deps.fetchImpl = async () => ({ ok: false, status: 403, text: async () => 'permission denied' });
  assert.equal(await run(['abc', '--tabs'], h.deps), 1);
  assert.deepEqual(h.err, ['HTTP 403: permission denied']);
  const absent = harness(); assert.equal(await run(['abc', '--tab', 'missing'], absent.deps), 1);
  assert.equal(absent.urls.length, 1);
});
test('invalid arguments fail before authentication', async () => {
  for (const args of [[], ['abc', '--max-rows', '0'], ['abc', '--max-rows', '1.5'], ['abc', '--grep', '['], ['abc', '--gid'], ['abc', '--range', 'Other!A1'], ['abc', '--gid', '0', '--tab', 'x'], ['abc', '--bogus']]) {
    const h = harness(); assert.equal(await run(args, h.deps), 1); assert.equal(h.auth.length, 0);
  }
});

test('authentication HTTP errors preserve status and body', async (t) => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { getDriveToken } = await import('./lib/drive-auth.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'sheet-auth-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyPath = join(dir, 'test-key.json');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  writeFileSync(keyPath, JSON.stringify({ client_email: 'test@example.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
  t.mock.method(globalThis, 'fetch', async () => ({ ok: false, status: 401, text: async () => '{"error":"invalid_grant"}' }));
  const h = harness();
  h.deps.getToken = (opts) => getDriveToken({ ...opts, keyPath });
  assert.equal(await run(['abc', '--tabs'], h.deps), 1);
  assert.deepEqual(h.err, ['HTTP 401: {"error":"invalid_grant"}']);
  assert.equal(h.urls.length, 0);
});
