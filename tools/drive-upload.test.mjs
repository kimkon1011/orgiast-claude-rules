import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, driveViewUrl, mimeFor, buildMultipartBody, resolveAs } from './drive-upload.mjs';

test('parseArgs: 必須と任意引数', () => {
  assert.deepEqual(parseArgs(['--file', 'a.pdf', '--folder', 'F1', '--name', 'x.pdf', '--as', 'u@e.jp']), { file: 'a.pdf', folder: 'F1', name: 'x.pdf', as: 'u@e.jp' });
  assert.throws(() => parseArgs(['--folder', 'F1']), /--file/);
  assert.throws(() => parseArgs(['--file', 'a']), /--folder/);
  assert.throws(() => parseArgs(['--file', 'a', '--folder']), /missing value/);
  assert.throws(() => parseArgs(['--bogus', '1']), /unknown option/);
});

test('driveViewUrl: authuser 付き', () => {
  assert.equal(driveViewUrl('ID1', 'u@e.jp'), 'https://drive.google.com/file/d/ID1/view?authuser=u%40e.jp');
});

test('mimeFor と multipart 本文', () => {
  assert.equal(mimeFor('a.PDF'), 'application/pdf');
  assert.equal(mimeFor('a.unknown'), 'application/octet-stream');
  const body = buildMultipartBody({ metadata: { name: 'a', parents: ['F'] }, content: Buffer.from('xyz'), mimeType: 'text/plain', boundary: 'B' }).toString();
  assert.match(body, /^--B\r\nContent-Type: application\/json/);
  assert.match(body, /xyz\r\n--B--$/);
});

test('resolveAs: --as > 環境変数 > git config、全部無ければエラー', () => {
  assert.equal(resolveAs({ as: 'a@x.jp' }, {}, () => 'g@x.jp'), 'a@x.jp');
  assert.equal(resolveAs({}, { GOOGLE_IMPERSONATE: 'e@x.jp' }, () => 'g@x.jp'), 'e@x.jp');
  assert.equal(resolveAs({}, {}, () => 'g@x.jp'), 'g@x.jp');
  assert.throws(() => resolveAs({}, {}, () => ''), /impersonate/);
});
