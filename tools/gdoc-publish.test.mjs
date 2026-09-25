import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDocument, buildRequests, verifyReadBack, publishDocument, parseArgs, main, DEFAULT_FOLDER } from './gdoc-publish.mjs';

function document(text, links = []) {
  const cuts = [...new Set([1, text.length + 1, ...links.flatMap(l => [l.startIndex, l.endIndex])])].sort((a, b) => a - b);
  const elements = cuts.slice(0, -1).map((startIndex, i) => {
    const endIndex = cuts[i + 1];
    const link = links.find(l => l.startIndex <= startIndex && l.endIndex >= endIndex);
    return { startIndex, endIndex, textRun: { content: text.slice(startIndex - 1, endIndex - 1), textStyle: link ? { link: { url: link.url } } : {} } };
  });
  return { documentId: 'doc-id', revisionId: 'rev-1', tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [{ endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: text.length + 1, paragraph: { elements } }] } } }] };
}

function mockApi(rendered, { existing = document('古い本文\n'), missingLinks = false, failBatch = false } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    getToken: async options => { assert.deepEqual(options, { impersonate: 'kim@orgiast.jp' }); return 'mock-token'; },
    api: async (token, url, options) => {
      assert.equal(token, 'mock-token');
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ url, ...options, body });
      let value;
      if (url.includes('fields=mimeType')) value = { mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } };
      else if (url.endsWith('/documents') && options.method === 'POST') value = { documentId: 'doc-id' };
      else if (url.endsWith('includeTabsContent=true')) value = reads++ === 0 ? existing : document(rendered.text, missingLinks ? [] : rendered.links);
      else if (url.endsWith(':batchUpdate')) {
        if (failBatch) throw new Error('400 revision conflict');
        value = {};
      } else if (url.includes('fields=parents')) value = { parents: ['old-folder'] };
      else if (options.method === 'PATCH') value = { id: 'doc-id' };
      else throw new Error(`Unexpected API request ${url}`);
      return new Response(JSON.stringify(value));
    },
  };
}

test('全角・絵文字・CRLF・見出し・リンクを変換して UTF-16 範囲を計算する', () => {
  const result = renderDocument('\uFEFF# 見出し😀\r\n■ [設定](https://example.test/a)\r\n1. https://example.test/b');
  assert.equal(result.text, '見出し😀\n■ 設定\n1. https://example.test/b\n');
  assert.deepEqual(result.headings, [{ startIndex: 1, endIndex: 6 }]);
  assert.deepEqual(result.links[0], { startIndex: 9, endIndex: 11, url: 'https://example.test/a' });
  for (const link of result.links) assert.equal(result.text.slice(link.startIndex - 1, link.endIndex - 1), link.url.endsWith('/a') ? '設定' : link.url);
});

test('同一URLを行末・文末・Markdownで繰り返しても全出現を保持する', () => {
  const url = 'https://example.test/a?x=1&y=2';
  const result = renderDocument(`日本語 ${url}\n[こちら](${url}) と ${url}`);
  assert.equal(result.links.length, 3);
  assert.ok(result.links.every(l => l.url === url));
  assert.equal(new Set(result.links.map(l => l.startIndex)).size, 3);
  assert.deepEqual(result.links.map(l => result.text.slice(l.startIndex - 1, l.endIndex - 1)), [url, 'こちら', url]);
});

test('Markdown URL内の括弧、太字・コードは表示文字にし、■/1.は保持する', () => {
  const result = renderDocument('■ **設定** `ON` [**説明**](https://example.test/a_(b))\n1. http://example.test');
  assert.equal(result.text, '■ 設定 ON 説明\n1. http://example.test\n');
  assert.equal(result.links[0].url, 'https://example.test/a_(b)');
  assert.equal(result.text.slice(result.links[0].startIndex - 1, result.links[0].endIndex - 1), '説明');
});

test('read-back は全リンクの URL と範囲を確認し、欠落・誤URL・部分設定・本文差異で失敗する', () => {
  const rendered = renderDocument('[設定](https://example.test) [設定](https://example.test)');
  assert.deepEqual(verifyReadBack(rendered, document(rendered.text, rendered.links)), { linkCount: 2 });
  for (const links of [[], rendered.links.slice(0, 1), rendered.links.map(l => ({ ...l, url: 'https://wrong.test' })), rendered.links.map(l => ({ ...l, endIndex: l.endIndex - 1 }))]) {
    assert.throws(() => verifyReadBack(rendered, document(rendered.text, links)), /リンク未設定または不一致/);
  }
  assert.throws(() => verifyReadBack(rendered, document('別の本文\n')), /本文が一致/);
  const split = rendered.links.flatMap(l => [{ ...l, endIndex: l.startIndex + 1 }, { ...l, startIndex: l.startIndex + 1 }]);
  assert.equal(verifyReadBack(rendered, document(rendered.text, split)).linkCount, 2);
});

test('置換は末尾改行を残し、全書式を同一batchで設定する', () => {
  const rendered = renderDocument('# 見出し\nhttps://example.test');
  const requests = buildRequests(rendered, document('以前😀\n'));
  assert.deepEqual(requests[0], { deleteContentRange: { range: { startIndex: 1, endIndex: 5, tabId: 't.0' } } });
  assert.equal(requests[1].insertText.text, rendered.text.slice(0, -1));
  assert.ok(requests.some(r => r.updateParagraphStyle?.paragraphStyle.namedStyleType === 'HEADING_2'));
  assert.ok(requests.some(r => r.updateTextStyle?.textStyle.link?.url === 'https://example.test'));
  assert.ok(!buildRequests(rendered, document('\n')).some(r => r.deleteContentRange));
});

test('作成は既定フォルダへ移動し、全リンクの読み戻し後にURLを返す', async () => {
  const source = '# 題名\n[設定](https://example.test)';
  const rendered = renderDocument(source);
  const mock = mockApi(rendered, { existing: document('\n') });
  const result = await publishDocument({ title: '題名', source }, mock);
  assert.equal(result.url, 'https://docs.google.com/a/orgiast.jp/document/d/doc-id/edit');
  assert.equal(result.linkCount, 1);
  const create = mock.calls.find(c => c.url.endsWith('/documents'));
  assert.deepEqual(create.body, { title: '題名' });
  const patch = mock.calls.find(c => c.method === 'PATCH');
  assert.equal(new URL(patch.url).searchParams.get('addParents'), DEFAULT_FOLDER);
  assert.equal(new URL(patch.url).searchParams.get('removeParents'), 'old-folder');
  assert.equal(mock.calls.at(-1).method, 'GET');
});

test('--update は同じID・配置を維持し revisionId で競合を防ぐ', async () => {
  const source = '[設定](https://example.test)';
  const mock = mockApi(renderDocument(source));
  const result = await publishDocument({ title: '題名', source, update: 'existing-id' }, mock);
  assert.equal(result.id, 'existing-id');
  assert.ok(mock.calls.every(c => c.url.includes('existing-id')));
  const batch = mock.calls.find(c => c.url.endsWith(':batchUpdate'));
  assert.deepEqual(batch.body.writeControl, { requiredRevisionId: 'rev-1' });
  assert.ok(batch.body.requests[0].deleteContentRange);
  assert.ok(!mock.calls.some(c => c.url.includes('addParents')));
});

test('明示フォルダはupdate時も適用される', async () => {
  const source = 'リンクなしでも本文を検証';
  const mock = mockApi(renderDocument(source));
  const result = await publishDocument({ title: '題名', source, update: 'existing-id', folder: 'chosen' }, mock);
  assert.equal(result.linkCount, 0);
  assert.equal(new URL(mock.calls.find(c => c.method === 'PATCH').url).searchParams.get('addParents'), 'chosen');
});

test('APIエラー・revision競合は成功にせず、後続の変更も行わない', async () => {
  const source = '本文';
  const mock = mockApi(renderDocument(source), { failBatch: true });
  await assert.rejects(publishDocument({ title: '題名', source, update: 'existing-id' }, mock), /revision conflict/);
  assert.equal(mock.calls.at(-1).url.endsWith(':batchUpdate'), true);
});

test('空本文・制御文字・複数タブは書き込み前に拒否する', async () => {
  assert.throws(() => renderDocument(' \n'), /空/);
  assert.throws(() => renderDocument('本文\u0001'), /制御文字/);
  const source = '本文';
  const existing = document('古い本文\n');
  existing.tabs.push(existing.tabs[0]);
  const mock = mockApi(renderDocument(source), { existing });
  await assert.rejects(publishDocument({ title: '題名', source, update: 'existing-id' }, mock), /複数タブ/);
  assert.ok(mock.calls.every(c => c.method === 'GET'));
});

test('CLI は成功時stdoutにURLだけ、リンク欠落時はexit 1を返す', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'gdoc-publish-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, '本文.md');
  const source = 'https://example.test';
  writeFileSync(file, source);
  for (const missingLinks of [false, true]) {
    const out = [], err = [];
    const code = await main(['--title', '題名', '--file', file, '--update', 'existing-id'], {
      ...mockApi(renderDocument(source), { missingLinks }), stdout: s => out.push(s), stderr: s => err.push(s),
    });
    assert.equal(code, missingLinks ? 1 : 0);
    assert.deepEqual(out, missingLinks ? [] : ['https://docs.google.com/a/orgiast.jp/document/d/existing-id/edit']);
    assert.match(err.join('\n'), missingLinks ? /リンク未設定/ : /リンク 1\/1 件 OK/);
  }
});

test('必須・未知・重複・値なし引数を検証する', () => {
  assert.deepEqual(parseArgs(['--title', '題名', '--file', '本文.md']), { title: '題名', file: '本文.md' });
  for (const args of [[], ['--title'], ['--title', '題名'], ['--bad', 'x'], ['--title', 'x', '--title', 'y'], ['--file', '--update']]) assert.throws(() => parseArgs(args));
});
