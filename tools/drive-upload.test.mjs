import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, driveViewUrl, mimeFor, buildMultipartBody, resolveAs, uploadPlan, uploadedFileUrl } from './drive-upload.mjs';

test('parseArgs: 必須と任意引数', () => {
  assert.deepEqual(parseArgs(['--file', 'a.pdf', '--folder', 'F1', '--name', 'x.pdf', '--as', 'u@e.jp']), { file: 'a.pdf', folder: 'F1', name: 'x.pdf', as: 'u@e.jp' });
  assert.throws(() => parseArgs(['--folder', 'F1']), /--file/);
  assert.throws(() => parseArgs(['--file', 'a']), /--folder/);
  assert.throws(() => parseArgs(['--file', 'a', '--folder']), /missing value/);
  assert.throws(() => parseArgs(['--bogus', '1']), /unknown option/);
  assert.equal(parseArgs(['--file', 'a.xlsx', '--folder', 'F1', '--keep-format'])['keep-format'], true);
});

test('uploadPlan: Office/CSV は Google 形式へ変換し、拡張子を外す', () => {
  const cases = [
    ['a.xlsx', 'application/vnd.google-apps.spreadsheet'], ['a.xls', 'application/vnd.google-apps.spreadsheet'], ['a.csv', 'application/vnd.google-apps.spreadsheet'],
    ['a.docx', 'application/vnd.google-apps.document'], ['a.doc', 'application/vnd.google-apps.document'],
    ['a.pptx', 'application/vnd.google-apps.presentation'], ['a.ppt', 'application/vnd.google-apps.presentation'],
  ];
  for (const [file, expected] of cases) {
    const plan = uploadPlan(file);
    assert.equal(plan.metadata.mimeType, expected, file);
    assert.equal(plan.metadata.name, 'a', file);
    assert.equal(plan.converted, true, file);
  }
});

test('uploadPlan: --keep-format と非 Office は変換しない', () => {
  const kept = uploadPlan('a.xlsx', '納品.xlsx', true);
  assert.deepEqual(kept.metadata, { name: '納品.xlsx' });
  assert.equal(kept.converted, false);
  const pdf = uploadPlan('a.pdf');
  assert.deepEqual(pdf.metadata, { name: 'a.pdf' });
  assert.equal(pdf.converted, false);
});

test('uploadedFileUrl: Google 形式ごとの編集 URL に authuser を付ける', () => {
  assert.equal(uploadedFileUrl('ID1', 'application/vnd.google-apps.spreadsheet', 'u@e.jp'), 'https://docs.google.com/spreadsheets/d/ID1/edit?authuser=u%40e.jp');
  assert.equal(uploadedFileUrl('ID2', 'application/vnd.google-apps.document', 'u@e.jp'), 'https://docs.google.com/document/d/ID2/edit?authuser=u%40e.jp');
  assert.equal(uploadedFileUrl('ID3', 'application/vnd.google-apps.presentation', 'u@e.jp'), 'https://docs.google.com/presentation/d/ID3/edit?authuser=u%40e.jp');
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
