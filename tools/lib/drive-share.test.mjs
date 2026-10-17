import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFileId, defaultRole, shareFile, recordShares, shareAndRecord } from './drive-share.mjs';

for (const value of [
  'abc_123-XYZ',
  ...['document', 'spreadsheets', 'presentation', 'forms'].flatMap(type => [
    `https://docs.google.com/${type}/d/abc_123-XYZ/edit`,
    `https://docs.google.com/a/orgiast.jp/${type}/d/abc_123-XYZ/edit`,
  ]),
  'https://drive.google.com/file/d/abc_123-XYZ/view',
  'https://drive.google.com/drive/folders/abc_123-XYZ',
  'https://drive.google.com/drive/u/0/folders/abc_123-XYZ',
  'https://drive.google.com/a/orgiast.jp/drive/folders/abc_123-XYZ',
  'https://drive.google.com/open?id=abc_123-XYZ',
]) test(`extractFileId: ${value}`, () => assert.equal(extractFileId(value), 'abc_123-XYZ'));
test('unrelated or malformed URLs are not file IDs', () => {
  for (const value of [null, '', 'a b', 'https://example.org/open?id=abc', 'https://drive.google.com/open?id=a/b']) assert.equal(extractFileId(value), null);
});
test('default roles use exact case-insensitive domain', () => {
  assert.equal(defaultRole('A@ORGIAST.JP'), 'writer');
  assert.equal(defaultRole('a@external.jp'), 'commenter');
  assert.equal(defaultRole('a@notorgiast.jp'), 'commenter');
});
test('shareFile paginates, skips higher permissions, adds and reports individual errors', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const u = new URL(url); calls.push({ u, options });
    assert.equal(options.headers.Authorization, 'Bearer token');
    assert.equal(u.searchParams.get('supportsAllDrives'), 'true');
    if (options.method !== 'POST') return Response.json(u.searchParams.has('pageToken')
      ? { permissions: [{ type: 'user', emailAddress: 'exists@orgiast.jp', role: 'owner' }] }
      : { permissions: [], nextPageToken: 'second' });
    assert.equal(u.searchParams.get('sendNotificationEmail'), 'false');
    const body = JSON.parse(options.body);
    return body.emailAddress === 'bad@external.jp' ? new Response('denied', { status: 403 }) : Response.json({ id: 'new' });
  });
  const result = await shareFile({ fileId: 'file123', emails: ['exists@orgiast.jp', 'new@external.jp', 'bad@external.jp'], auth: 'token' });
  assert.deepEqual(result.map(r => [r.role, r.status]), [['writer', 'exists'], ['commenter', 'added'], ['commenter', 'error']]);
  assert.match(result[2].error, /403/);
  assert.equal(calls.length, 4);
});
test('lower or expired permission is not skipped; explicit role wins', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => options.method === 'POST'
    ? Response.json({}) : Response.json({ permissions: [
      { type: 'user', emailAddress: 'a@orgiast.jp', role: 'reader' },
      { type: 'user', emailAddress: 'b@orgiast.jp', role: 'owner', expirationTime: '2000-01-01' },
    ] }));
  const results = await shareFile({ fileId: 'id', emails: 'a@orgiast.jp,b@orgiast.jp', role: 'writer', auth: 'token' });
  assert.deepEqual(results.map(r => r.status), ['added', 'added']);
});
test('list failure returns errors for every recipient', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('no access', { status: 403 }));
  const results = await shareFile({ fileId: 'id', emails: 'a@orgiast.jp,b@example.com', auth: 'token' });
  assert.deepEqual(results.map(r => r.status), ['error', 'error']);
});
test('ledger records only successful recipients with actual per-recipient roles', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-ledger-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const ledger = path.join(dir, '.claude', 'share-ledger.jsonl');
  recordShares('id', [{ email: 'a@orgiast.jp', role: 'writer', status: 'exists' }, { email: 'b@example.com', role: 'commenter', status: 'added' }, { email: 'c@example.com', role: 'reader', status: 'error' }], ledger);
  const rows = fs.readFileSync(ledger, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => [r.fileId, r.emails, r.role]), [['id', ['a@orgiast.jp'], 'writer'], ['id', ['b@example.com'], 'commenter']]);
});
test('partial failure is reported and still records successful shares', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-partial-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  t.mock.method(globalThis, 'fetch', async (url, options) => options.method !== 'POST' ? Response.json({ permissions: [] })
    : JSON.parse(options.body).emailAddress.startsWith('bad') ? new Response('denied', { status: 403 }) : Response.json({}));
  const ledgerPath = path.join(dir, 'ledger'); const out = [], err = [];
  await assert.rejects(shareAndRecord({ fileId: 'id', name: '文書', emails: 'ok@orgiast.jp,bad@example.com', auth: 'token' }, { ledgerPath, stdout: s => out.push(s), stderr: s => err.push(s) }));
  assert.equal(out[0], '共有済み: ok@orgiast.jp (writer) 文書');
  assert.equal(err.length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(ledgerPath, 'utf8')).emails, ['ok@orgiast.jp']);
});
test('existing creation CLIs accept share and share-role', async () => {
  for (const [file, args] of [
    ['../gdoc-create.mjs', ['--file', 'body.md']],
    ['../gdoc-publish.mjs', ['--file', 'body.md', '--title', 'title']],
    ['../drive-upload.mjs', ['--file', 'body.md', '--folder', 'folder']],
  ]) {
    const { parseArgs } = await import(file);
    const parsed = parseArgs([...args, '--share', 'a@orgiast.jp,b@example.com', '--share-role', 'reader']);
    assert.equal(parsed.share, 'a@orgiast.jp,b@example.com');
    assert.equal(parsed['share-role'], 'reader');
  }
});
test('share CLI dry run does not authenticate, write permissions, or create a ledger', async t => {
  const { main } = await import('../drive-share.mjs');
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('dry run must not fetch'); });
  const lines = []; t.mock.method(console, 'log', value => lines.push(value));
  assert.equal(await main(['--id', 'id', '--to', 'a@orgiast.jp,b@example.com', '--dry']), 0);
  assert.deepEqual(lines, ['dry: id → a@orgiast.jp (writer)', 'dry: id → b@example.com (commenter)']);
});
