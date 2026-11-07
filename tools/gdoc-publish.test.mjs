import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderDocument, buildRequests, verifyReadBack, publishDocument, parseArgs, main, DEFAULT_FOLDER, containsSecret } from './gdoc-publish.mjs';
import { renderHtml } from './gdoc-publish.mjs';

function fallbackApi({ error = '403 SERVICE_DISABLED', exported = '題名\n設定\n', failDrive = false, existing } = {}) {
  const calls = [], warnings = [], grants = [];
  return { calls, warnings, grants, stderr: text => warnings.push(text), getToken: async () => 'test',
    ensure: async id => grants.push(id),
    api: async (_token, url, options = {}) => {
      calls.push({ url, ...options });
      if (url.startsWith('https://docs.googleapis.com')) throw new Error(error);
      if (url.includes('/upload/')) {
        if (failDrive) throw new Error('Drive conversion failed');
        return Response.json({ id: existing || 'converted' });
      }
      if (url.includes('/export?')) return new Response(exported);
      if (url.includes('fields=mimeType')) return Response.json({ mimeType: 'application/vnd.google-apps.folder', capabilities: { canAddChildren: true } });
      if (url.includes('fields=parents')) return Response.json({ parents: [DEFAULT_FOLDER] });
      if (options.method === 'PATCH') return Response.json({ id: existing || 'converted' });
      throw new Error(`unexpected ${url}`);
    },
  };
}
for (const error of ['403 SERVICE_DISABLED', '403 PERMISSION_DENIED']) test(`${error}: converts HTML and verifies Drive text export`, async () => {
  const mock = fallbackApi({ error });
  const result = await publishDocument({ title: '題名', source: '# 題名\n[設定](https://example.test/?a=1&b=2)', authuser: 'kim@orgiast.jp' }, mock);
  assert.equal(result.id, 'converted'); assert.equal(result.verification, 'drive-text-export');
  const upload = mock.calls.find(c => c.url.includes('/upload/'));
  assert.equal(upload.method, 'POST'); assert.match(upload.body, /text\/html/);
  assert.match(upload.body, /<a href="https:\/\/example.test\/\?a=1&amp;b=2">設定<\/a>/);
  assert.match(upload.body, /application\/vnd.google-apps.document/);
  assert.deepEqual(mock.grants, ['converted']); assert.equal(mock.warnings.length, 1);
  assert.ok(mock.calls.at(-1).url.includes('/export?'));
});
test('fallback update preserves ID and does not create a replacement', async () => {
  const mock = fallbackApi({ existing: 'existing' });
  assert.equal((await publishDocument({ title: '題名', source: '題名\n設定', update: 'existing', authuser: 'kim@orgiast.jp' }, mock)).id, 'existing');
  const upload = mock.calls.find(c => c.url.includes('/upload/'));
  assert.equal(upload.method, 'PATCH'); assert.match(upload.url, /files\/existing\?/);
  assert.ok(mock.calls.every(c => c.method !== 'POST'));
});
test('unrelated 403, conversion failure and mismatched exports fail closed', async () => {
  for (const options of [{ error: '403 rateLimitExceeded' }, { failDrive: true }, { exported: '欠落' }]) {
    const mock = fallbackApi(options);
    await assert.rejects(publishDocument({ title: '題名', source: '題名\n設定', authuser: 'kim@orgiast.jp' }, mock));
    if (options.error) assert.ok(!mock.calls.some(c => c.url.includes('/upload/')));
  }
});
test('HTML conversion escapes markup and preserves link labels', () => {
  const html = renderHtml(renderDocument('<script> [表示](https://example.test/?q="x"&v=2)'));
  assert.ok(!html.includes('<script>')); assert.match(html, /&lt;script&gt;/);
  assert.match(html, /q=&quot;x&quot;&amp;v=2/);
});

function document(text, links = []) {
  const cuts = [...new Set([1, text.length + 1, ...links.flatMap(l => [l.startIndex, l.endIndex])])].sort((a, b) => a - b);
  const elements = cuts.slice(0, -1).map((startIndex, i) => {
    const endIndex = cuts[i + 1];
    const link = links.find(l => l.startIndex <= startIndex && l.endIndex >= endIndex);
    return { startIndex, endIndex, textRun: { content: text.slice(startIndex - 1, endIndex - 1), textStyle: link ? { link: { url: link.url } } : {} } };
  });
  return { documentId: 'doc-id', revisionId: 'rev-1', tabs: [{ tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [{ endIndex: 1, sectionBreak: {} }, { startIndex: 1, endIndex: text.length + 1, paragraph: { elements } }] } } }] };
}

function mockApi(rendered, { existing = document('古い本文\n'), missingLinks = false, failBatch = false, permissions } = {}) {
  const calls = [];
  let reads = 0;
  return {
    calls,
    ensure: async () => {},
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
      else if (url.includes('/permissions?')) value = { permissions: permissions ?? [{ id: 'p1', role: 'owner' }] };
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
  const result = await publishDocument({ authuser: 'reader@example.com', title: '題名', source }, mock);
  assert.equal(result.url, 'https://docs.google.com/document/d/doc-id/edit?authuser=reader%40example.com');
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
  const result = await publishDocument({ authuser: 'reader@example.com', title: '題名', source, update: 'existing-id' }, mock);
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
  const result = await publishDocument({ authuser: 'reader@example.com', title: '題名', source, update: 'existing-id', folder: 'chosen' }, mock);
  assert.equal(result.linkCount, 0);
  assert.equal(new URL(mock.calls.find(c => c.method === 'PATCH').url).searchParams.get('addParents'), 'chosen');
});

test('APIエラー・revision競合は成功にせず、後続の変更も行わない', async () => {
  const source = '本文';
  const mock = mockApi(renderDocument(source), { failBatch: true });
  await assert.rejects(publishDocument({ authuser: 'reader@example.com', title: '題名', source, update: 'existing-id' }, mock), /revision conflict/);
  assert.equal(mock.calls.at(-1).url.endsWith(':batchUpdate'), true);
});

test('空本文・制御文字・複数タブは書き込み前に拒否する', async () => {
  assert.throws(() => renderDocument(' \n'), /空/);
  assert.throws(() => renderDocument('本文\u0001'), /制御文字/);
  const source = '本文';
  const existing = document('古い本文\n');
  existing.tabs.push(existing.tabs[0]);
  const mock = mockApi(renderDocument(source), { existing });
  await assert.rejects(publishDocument({ authuser: 'reader@example.com', title: '題名', source, update: 'existing-id' }, mock), /複数タブ/);
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
    const code = await main(['--authuser', 'reader@example.com', '--title', '題名', '--file', file, '--update', 'existing-id'], {
      ...mockApi(renderDocument(source), { missingLinks }), stdout: s => out.push(s), stderr: s => err.push(s),
    });
    assert.equal(code, missingLinks ? 1 : 0);
    assert.deepEqual(out, missingLinks ? [] : ['reader@example.com で開いてください: https://docs.google.com/document/d/existing-id/edit?authuser=reader%40example.com']);
    assert.match(err.join('\n'), missingLinks ? /リンク未設定/ : /リンク 1\/1 件 OK/);
  }
});

test('必須・未知・重複・値なし引数を検証する', () => {
  assert.deepEqual(parseArgs(['--title', '題名', '--file', '本文.md']), { title: '題名', file: '本文.md' });
  for (const args of [[], ['--title'], ['--title', '題名'], ['--bad', 'x'], ['--title', 'x', '--title', 'y'], ['--file', '--update']]) assert.throws(() => parseArgs(args));
});

test('--share shares the created document and records recipients using the same token', async t => {
  const { readFileSync } = await import('node:fs');
  const home = mkdtempSync(join(tmpdir(), 'publish-share-'));
  const previousHome = process.env.ORGIAST_HOME;
  process.env.ORGIAST_HOME = home;
  t.after(() => {
    if (previousHome === undefined) delete process.env.ORGIAST_HOME;
    else process.env.ORGIAST_HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });
  const writes = [], output = [];
  t.mock.method(console, 'log', line => output.push(line));
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.match(url, /\/files\/doc-id\/permissions\?/);
    assert.equal(options.headers.Authorization, 'Bearer mock-token');
    if (options.method === 'POST') writes.push(JSON.parse(options.body));
    return Response.json(options.method === 'POST' ? { id: 'permission' } : { permissions: [] });
  });
  const source = '本文';
  const result = await publishDocument({ title: '共有文書', source, authuser: 'a@orgiast.jp', share: 'a@orgiast.jp,b@example.com' }, mockApi(renderDocument(source)));
  assert.equal(result.id, 'doc-id');
  assert.deepEqual(writes.map(p => p.role), ['writer', 'commenter', 'writer']);
  const rows = readFileSync(join(home, '.claude/share-ledger.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(r => r.fileId), ['doc-id', 'doc-id', 'doc-id']);
  assert.equal(output.length, 3);
});

test('containsSecret は正例6種と負例を正しく判定する', () => {
  // 正例6種
  assert.equal(containsSecret('MY_API_KEY=12345678'), true);
  assert.equal(containsSecret('-----BEGIN RSA PRIVATE KEY-----'), true);
  assert.equal(containsSecret('sk-12345678901234567890'), true);
  assert.equal(containsSecret('ghp_12345678901234567890'), true);
  assert.equal(containsSecret('xoxb-1234567890'), true);
  assert.equal(containsSecret('AIzaSy1234567890123456789012345678'), true);

  // 負例
  assert.equal(containsSecret('TOKEN の説明'), false);
  assert.equal(containsSecret('TOKEN=short'), false);
  assert.equal(containsSecret('本文テキスト'), false);
});

test('秘密ありかつ --private なしは Drive 呼び出しゼロで exit 3 となる', async () => {
  const calls = [];
  const mock = {
    getToken: async () => 'mock-token',
    api: async (_token, url) => { calls.push(url); return new Response('{}'); },
    ensure: async () => {},
  };
  const source = 'MY_API_KEY=12345678';
  await assert.rejects(
    publishDocument({ title: '秘密文書', source, authuser: 'kim@orgiast.jp' }, mock),
    err => {
      assert.equal(err.exitCode, 3);
      assert.match(err.message, /秘密らしい行を含むため共有フォルダに置けません/);
      return true;
    }
  );
  assert.equal(calls.length, 0);

  const dir = mkdtempSync(join(tmpdir(), 'gdoc-secret-'));
  try {
    const file = join(dir, 'secret.md');
    writeFileSync(file, source);
    const errs = [];
    const code = await main(['--authuser', 'kim@orgiast.jp', '--title', '秘密文書', '--file', file], {
      ...mock, stderr: msg => errs.push(msg),
    });
    assert.equal(code, 3);
    assert.match(errs.join('\n'), /秘密らしい行を含むため共有フォルダに置けません/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--private と --share 併用で exit 2 となる', async () => {
  assert.throws(
    () => parseArgs(['--title', '題名', '--file', 'file.md', '--private', '--share', 'user@example.com']),
    err => {
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /--private と --share は併用できません/);
      return true;
    }
  );

  const dir = mkdtempSync(join(tmpdir(), 'gdoc-private-share-'));
  try {
    const file = join(dir, 'doc.md');
    writeFileSync(file, '本文');
    const errs = [];
    const code = await main(['--authuser', 'kim@orgiast.jp', '--title', '題名', '--file', file, '--private', '--share', 'user@example.com'], {
      stderr: msg => errs.push(msg),
    });
    assert.equal(code, 2);
    assert.match(errs.join('\n'), /--private と --share は併用できません/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--private 読み戻しで owner 以外があれば exit 4 となる', async () => {
  const source = '本文';
  const rendered = renderDocument(source);
  const mockWithSharedPerms = mockApi(rendered, {
    permissions: [
      { id: 'p1', role: 'owner' },
      { id: 'p2', role: 'reader' },
    ],
  });

  await assert.rejects(
    publishDocument({ title: '非公開', source, authuser: 'kim@orgiast.jp', private: true }, mockWithSharedPerms),
    err => {
      assert.equal(err.exitCode, 4);
      assert.match(err.message, /owner 以外の権限が存在します/);
      return true;
    }
  );

  const mockOwnerOnly = mockApi(rendered, {
    permissions: [{ id: 'p1', role: 'owner' }],
  });
  const dir = mkdtempSync(join(tmpdir(), 'gdoc-private-ok-'));
  try {
    const file = join(dir, 'doc.md');
    writeFileSync(file, source);
    const errs = [], outs = [];
    const code = await main(['--authuser', 'kim@orgiast.jp', '--title', '非公開', '--file', file, '--private'], {
      ...mockOwnerOnly, stdout: msg => outs.push(msg), stderr: msg => errs.push(msg),
    });
    assert.equal(code, 0);
    assert.match(errs.join('\n'), /read-back: 共有先は owner のみ/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
