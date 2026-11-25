import test from 'node:test';
import assert from 'node:assert/strict';
import { workspaceUrl } from './lib/workspace-url.mjs';
import { driveViewUrl, parseArgs } from './drive-upload.mjs';
import { docUrl } from './gdoc-create.mjs';
import { publishDocument } from './gdoc-publish.mjs';
test('URL はクエリと fragment を保持し、受け手を指定・置換する', () => {
  const url = workspaceUrl('https://docs.google.com/a/orgiast.jp/document/d/ID/edit?usp=sharing&authuser=old%40example.com#heading=h', 'reader@example.com');
  assert.equal(url, 'https://docs.google.com/document/d/ID/edit?usp=sharing&authuser=reader%40example.com#heading=h');
});
test('メールなし・番号・不正な値で URL を出さない', () => {
  for (const account of [undefined, '', '0', 'a@example.com&x=1']) {
    assert.throws(() => driveViewUrl('ID', account), /authuser/);
    assert.throws(() => docUrl('ID', account), /authuser/);
  }
});
test('publish は authuser 不足で API を呼ばない', async () => {
  await assert.rejects(publishDocument({ source: 'text' }, { getToken: () => assert.fail('must not authenticate') }), /authuser/);
});
test('Drive の操作ユーザーと受け手は別々に指定できる', () => {
  const args = parseArgs(['--file', 'x', '--folder', 'F', '--as', 'operator@example.com', '--authuser', 'reader@example.com']);
  assert.equal(args.as, 'operator@example.com');
  assert.equal(args.authuser, 'reader@example.com');
});
