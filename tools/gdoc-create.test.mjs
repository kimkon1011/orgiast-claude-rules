import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseArgs,
  deriveTitle,
  buildSearchQuery,
  buildMultipartBody,
  docUrl,
  checkReadBack,
} from './gdoc-create.mjs';

test('deriveTitle は最初のレベル1見出しからタイトルを導出する', () => {
  assert.equal(deriveTitle('# 見出し\n本文', 'body.md'), '見出し');
  assert.equal(deriveTitle('前書き\n# 最初\n# 次', 'body.md'), '最初');
  assert.equal(deriveTitle('# 見出し\r\n本文', 'body.md'), '見出し');
});

test('deriveTitle はレベル1見出しがなければファイル名を使う', () => {
  assert.equal(deriveTitle('本文', '/tmp/議事録.v2.md'), '議事録.v2');
  assert.equal(deriveTitle('##\n本文', 'body.md'), 'body');
  assert.equal(deriveTitle('## 小見出し\n本文', 'body.md'), 'body');
  assert.equal(deriveTitle('# \n本文', 'body.md'), 'body');
  assert.equal(deriveTitle('本文', 'C:\\資料\\議事録.md'), '議事録');
  assert.equal(deriveTitle('本文', '議事録'), '議事録');
});

test('buildSearchQuery は削除済みを除き、同名の Google Doc を検索する', () => {
  const query = buildSearchQuery("kim's doc");
  assert.equal(query, "name = 'kim\\'s doc' and mimeType = 'application/vnd.google-apps.document' and trashed = false");
  assert.ok(!query.includes('in parents'));
});

test('buildSearchQuery は親フォルダを絞り、バックスラッシュもエスケープする', () => {
  assert.ok(buildSearchQuery('資料', 'folder-id').endsWith(" and 'folder-id' in parents"));
  assert.ok(buildSearchQuery('a\\b').startsWith("name = 'a\\\\b'"));
  assert.ok(buildSearchQuery('資料', "folder'id").endsWith(" and 'folder\\'id' in parents"));
});

test('buildMultipartBody は日本語を UTF-8 のまま multipart に格納する', () => {
  const metadata = { name: '日本語資料', mimeType: 'application/vnd.google-apps.document', parents: ['folder-id'] };
  const media = '# 日本語の見出し\n本文：こんにちは 🌸\n';
  const boundary = 'test-boundary';
  const body = buildMultipartBody({ metadata, media, boundary });
  const expected = '--test-boundary\r\nContent-Type: application/json\r\n\r\n' +
    JSON.stringify(metadata) + '\r\n--test-boundary\r\nContent-Type: text/markdown\r\n\r\n' +
    media + '\r\n--test-boundary--\r\n';
  assert.ok(Buffer.isBuffer(body));
  assert.equal(body.toString('utf8'), expected);
  assert.equal(body.length, Buffer.byteLength(expected, 'utf8'));
  assert.ok(body.length > expected.length);
  assert.ok(body.includes(Buffer.from(media, 'utf8')));
});

test('buildMultipartBody は親フォルダなしのメタデータも保持する', () => {
  const metadata = { name: '資料', mimeType: 'application/vnd.google-apps.document' };
  const body = buildMultipartBody({ metadata, media: '本文', boundary: 'b' }).toString('utf8');
  assert.ok(body.includes(JSON.stringify(metadata)));
  assert.ok(!body.includes('parents'));
});

test('docUrl は必ず orgiast.jp のアカウント指定を含む', () => {
  assert.equal(docUrl('doc-id'), 'https://docs.google.com/a/orgiast.jp/document/d/doc-id/edit');
});

test('checkReadBack は先頭非空行を使い、見出し記号を除いて照合する', () => {
  assert.equal(checkReadBack('見出し\n本文', '見出し\n本文'), true);
  assert.equal(checkReadBack('# 見出し\n本文', '見出し\n本文'), true);
  assert.equal(checkReadBack('\n\r\n### 見出し\r\n本文', '前文\n見出し\n本文'), true);
  assert.equal(checkReadBack('# 見出し\n本文', '異なる内容'), false);
});

test('checkReadBack は30字までを照合し、それ以降の差は判定に使わない', () => {
  const prefix = 'あ'.repeat(30);
  assert.equal(checkReadBack(`# ${prefix}後続`, `${prefix}別の後続`), true);
  assert.equal(checkReadBack(`# ${prefix}後続`, 'あ'.repeat(29)), false);
});

test('checkReadBack は空の入力について既存ツールと同じ判定をする', () => {
  assert.equal(checkReadBack('\n  \n', ''), false);
  assert.equal(checkReadBack('', '本文'), true);
});

test('parseArgs はファイル、タイトルとフラグを解釈する', () => {
  const args = parseArgs(['--file', 'x.md', '--dry', '--title', '日本語のタイトル', '--force-new']);
  assert.equal(args.file, 'x.md');
  assert.equal(args.title, '日本語のタイトル');
  assert.deepEqual(args.flags, new Set(['dry', 'force-new']));
});

test('parseArgs は既存ツールと同じく未知のオプションも値として保持する', () => {
  const args = parseArgs(['--parent', 'folder-id', '--key', 'key.json', '--subject', 'kim@orgiast.jp', '--unknown', 'value']);
  assert.equal(args.parent, 'folder-id');
  assert.equal(args.key, 'key.json');
  assert.equal(args.subject, 'kim@orgiast.jp');
  assert.equal(args.unknown, 'value');
  assert.deepEqual(args.flags, new Set());
  assert.deepEqual(parseArgs(['--key=value', 'next']), { flags: new Set(), 'key=value': 'next' });
});
