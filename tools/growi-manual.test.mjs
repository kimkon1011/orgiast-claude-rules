import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIndex, extractGrowiCsrf, fetchGrowiBodies, generateGrowiParts, ingestFiles, installIndexFiles, listGrowiPages, loginGrowi, parsePart, publishIndex, syncGrowi } from './growi-manual.mjs';

const tool = fileURLToPath(new URL('./growi-manual.mjs', import.meta.url));
const delimiter = '================================================== 次のページ ==================================================';

function sample(part = 1, total = 14) {
  return `\uFEFF【社内マニュアル - Part ${part}/${total}】\r\n更新日時: 2026/08/26 02:27:43\r\n文字数: 123 文字\r\n================================================================================\r\n\r\n### ページタイトル: 採用 手順A\r\n--- 内部パス: /13:人事部/採用/A ---\r\n\r\n---------- マニュアル本文 ----------\r\n日本語の本文A\r\n=== 本文内の記号 ===\r\n### 本文中の見出し\r\n${delimiter}\r\n\r\n### ページタイトル: 採用 手順B\r\n--- 内部パス: /13:人事部/採用/B ---\r\n\r\n---------- マニュアル本文 ----------\r\n本文B\r\n================================================== 区切りに似た行 ==================================================\r\nまだ本文B\r\n${delimiter}\r\n\r\n### ページタイトル: 経理処理\r\n--- 内部パス: /14:経理部/処理 ---\r\n\r\n---------- マニュアル本文 ----------\r\n末尾本文C`; 
}

function temporaryCache(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growi-manual-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function run(cache, args) {
  return spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8', env: { ...process.env, GROWI_MANUAL_CACHE_DIR: cache } });
}

test('CRLF・BOM・本文内見出しや等号を含む合成 Part を3ページに分割する', () => {
  const parsed = parsePart(sample(), 1);
  assert.equal(parsed.pages.length, 3);
  assert.deepEqual(parsed.pages.map((page) => page.title), ['採用 手順A', '採用 手順B', '経理処理']);
  assert.deepEqual(parsed.pages.map((page) => page.path), ['/13:人事部/採用/A', '/13:人事部/採用/B', '/14:経理部/処理']);
  assert.match(Buffer.from(parsed.normalized).subarray(parsed.pages[1].byteStart, parsed.pages[1].byteEnd).toString(), /まだ本文B/);
});

test('byteStart/byteEnd はUTF-8マルチバイト境界を保つ', () => {
  const parsed = parsePart(sample(), 1);
  const bytes = Buffer.from(parsed.normalized, 'utf8');
  assert.equal(bytes.subarray(parsed.pages[0].byteStart, parsed.pages[0].byteEnd).toString('utf8'), '日本語の本文A\n=== 本文内の記号 ===\n### 本文中の見出し\n');
  assert.equal(bytes.subarray(parsed.pages[2].byteStart, parsed.pages[2].byteEnd).toString('utf8'), '末尾本文C');
});

test('search は本文を出さず、--body でも結果はTSVだけ', (t) => {
  const cache = temporaryCache(t);
  fs.writeFileSync(path.join(cache, 'part01.txt'), sample());
  buildIndex(cache);
  const normal = run(cache, ['search', '本文A']);
  assert.equal(normal.status, 0);
  assert.equal(normal.stdout.trim(), 'no match');
  const body = run(cache, ['search', '日本語の本文A', '--body']);
  assert.equal(body.status, 0);
  assert.match(body.stdout, /^p0001\t1\t採用 手順A\t\/13:人事部\/採用\/A\n$/);
  assert.doesNotMatch(body.stdout, /日本語の本文A/);
});

test('get はタイトル部分一致が複数なら候補を出して exit 1', (t) => {
  const cache = temporaryCache(t);
  fs.writeFileSync(path.join(cache, 'part01.txt'), sample());
  buildIndex(cache);
  const result = run(cache, ['get', '採用']);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /p0001\t1\t採用 手順A/);
  assert.match(result.stdout, /p0002\t1\t採用 手順B/);
  assert.doesNotMatch(result.stdout, /日本語の本文A/);
});

test('ingest はMCP保存JSON(base64)と生txtの両方を取り込む', (t) => {
  const cache = temporaryCache(t);
  const input = fs.mkdtempSync(path.join(os.tmpdir(), 'growi-input-'));
  t.after(() => fs.rmSync(input, { recursive: true, force: true }));
  const jsonFile = path.join(input, 'part1.json');
  const textFile = path.join(input, 'part2.txt');
  fs.writeFileSync(jsonFile, JSON.stringify({ content: Buffer.from(sample(1, 2)).toString('base64'), id: 'a', mimeType: 'text/plain', title: 'Part01' }));
  fs.writeFileSync(textFile, sample(2, 2));
  const result = ingestFiles([jsonFile, textFile], cache);
  assert.equal(result.ingested, 2);
  assert.equal(result.parts, 2);
  assert.equal(result.pages, 6);
  assert.ok(fs.existsSync(path.join(cache, 'part01.txt')));
  assert.ok(fs.existsSync(path.join(cache, 'part02.txt')));
});

function indexFixtures(dir) {
  fs.writeFileSync(path.join(dir, 'part01.txt'), sample(1, 2));
  fs.writeFileSync(path.join(dir, 'part02.txt'), sample(2, 2));
  buildIndex(dir, new Map([[1, { fileId: 'drive-part-1' }], [2, { fileId: 'drive-part-2' }]]));
  return {
    index: fs.readFileSync(path.join(dir, 'index.tsv'), 'utf8'),
    meta: fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'),
  };
}

test('install-index はMCP保存JSONと生ファイルを順序に関係なく振り分ける', (t) => {
  const source = temporaryCache(t);
  const fixture = indexFixtures(source);
  for (const reverse of [false, true]) {
    const cache = temporaryCache(t);
    const input = temporaryCache(t);
    const index = path.join(input, 'unknown-a.json');
    const meta = path.join(input, 'unknown-b.json');
    fs.writeFileSync(index, JSON.stringify({ content: Buffer.from(fixture.index).toString('base64'), title: 'download' }));
    fs.writeFileSync(meta, fixture.meta);
    const files = reverse ? [meta, index] : [index, meta];
    assert.deepEqual(installIndexFiles(files, cache), { parts: 2, pages: 6 });
    assert.match(fs.readFileSync(path.join(cache, 'index.tsv'), 'utf8'), /^p0001\t1\t/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cache, 'meta.json'), 'utf8')).parts.length, 2);
  }
});

test('本文が1つもなくても search が結果を返す', (t) => {
  const source = temporaryCache(t);
  const fixture = indexFixtures(source);
  const cache = temporaryCache(t);
  const index = path.join(cache, 'source.tsv');
  const meta = path.join(cache, 'source.json');
  fs.writeFileSync(index, fixture.index); fs.writeFileSync(meta, fixture.meta);
  installIndexFiles([meta, index], cache);
  const result = run(cache, ['search', '経理処理']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /p0003\t1\t経理処理/);
});

test('未取得 Part の get は exit 3 で fileId と ingest 手順を案内する', (t) => {
  const source = temporaryCache(t); const fixture = indexFixtures(source); const cache = temporaryCache(t);
  const index = path.join(cache, 'source.tsv'); const meta = path.join(cache, 'source.json');
  fs.writeFileSync(index, fixture.index); fs.writeFileSync(meta, fixture.meta); installIndexFiles([index, meta], cache);
  const result = run(cache, ['get', 'p0001']);
  assert.equal(result.status, 3);
  assert.match(result.stderr, /fileId: drive-part-1/);
  assert.match(result.stderr, /ingest <保存パス>/);
});

test('--body は未取得 Part を除外して注意を出すが exit 0', (t) => {
  const source = temporaryCache(t); const fixture = indexFixtures(source); const cache = temporaryCache(t);
  const index = path.join(cache, 'source.tsv'); const meta = path.join(cache, 'source.json');
  fs.writeFileSync(index, fixture.index); fs.writeFileSync(meta, fixture.meta); installIndexFiles([index, meta], cache);
  fs.writeFileSync(path.join(cache, 'part01.txt'), sample(1, 2));
  const result = run(cache, ['search', '日本語の本文A', '--body']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /p0001/);
  assert.match(result.stderr, /注意: 未取得の Part 2 は本文検索の対象外です/);
});

test('status は本文ありと索引のみを出し分ける', (t) => {
  const source = temporaryCache(t); const fixture = indexFixtures(source); const cache = temporaryCache(t);
  const index = path.join(cache, 'source.tsv'); const meta = path.join(cache, 'source.json');
  fs.writeFileSync(index, fixture.index); fs.writeFileSync(meta, fixture.meta); installIndexFiles([index, meta], cache);
  fs.writeFileSync(path.join(cache, 'part01.txt'), sample(1, 2));
  const result = run(cache, ['status']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Part 1:.*\[本文あり\]/);
  assert.match(result.stdout, /Part 2:.*\[索引のみ\]/);
});

test('status は Growi 直同期の同期元を表示する', (t) => {
  const cache = temporaryCache(t);
  fs.writeFileSync(path.join(cache, 'part01.txt'), sample());
  buildIndex(cache);
  const metaFile = path.join(cache, 'meta.json');
  const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
  meta.source = 'growi-sync'; meta.growiSyncedAt = '2026-09-06T01:02:03.000Z';
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  const result = run(cache, ['status']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /索引: growi-sync 2026-09-06T01:02:03.000Z/);
});

test('引数なしは usage を stderr に出して exit 2', (t) => {
  const result = run(temporaryCache(t), []);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test('シンボリックリンク経由で起動されても main が走る（無言 exit 0 の回帰）', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'growi-link-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const link = path.join(dir, 'growi-manual.mjs');
  try {
    fs.symlinkSync(tool, link, 'file');
  } catch {
    t.skip('この環境ではシンボリックリンクを作れない');
    return;
  }
  // 実際にリンク経由で起動しても usage が出る（無言 exit 0 にならない）
  const result = spawnSync(process.execPath, [link], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});

test('React SPA の csrftoken data属性から CSRF を取得する', () => {
  assert.equal(extractGrowiCsrf('<main data-x="1" csrftoken="csrf-value"></main>'), 'csrf-value');
});

test('Growi ログインは302だけを成功として扱う', async () => {
  const calls = [];
  const http302 = async (_url, options = {}) => {
    calls.push(options);
    if (!options.method) return new Response('<div csrftoken="token-1"></div>', { status: 200, headers: { 'set-cookie': 'sid=abc; Path=/' } });
    return new Response(null, { status: 302, headers: { location: '/' } });
  };
  const session = await loginGrowi({ baseUrl: 'https://growi.example', user: 'user', password: 'pass', http: http302 });
  assert.equal(typeof session, 'function');
  assert.match(String(calls[1].body), /loginForm%5Busername%5D=user/);
  assert.equal(calls[1].headers.Cookie, 'sid=abc');

  const http200 = async (_url, options = {}) => options.method
    ? new Response('<div>login</div>', { status: 200 })
    : new Response('<div csrftoken="token-2"></div>', { status: 200 });
  await assert.rejects(loginGrowi({ baseUrl: 'https://growi.example', user: 'user', password: 'bad', http: http200 }), /HTTP 200/);
});

test('Growi ページ列挙は limit=500 を無視する20件固定APIでも全件を重複・欠落なく取得する', async () => {
  const expected = Array.from({ length: 130 }, (_, index) => ({ _id: `page-${index}`, path: `/page-${index}`, updatedAt: 'now' }));
  const offsets = [];
  const http = async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    offsets.push(offset);
    return new Response(JSON.stringify({ data: { pages: expected.slice(offset, offset + 20), totalCount: expected.length } }), {
      status: 200, headers: { 'content-type': 'application/json' },
    });
  };
  const result = await listGrowiPages('https://growi.example', http, 500);
  const ids = result.pages.map((page) => page._id);
  assert.equal(result.pages.length, expected.length);
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(new Set(ids), new Set(expected.map((page) => page._id)));
  assert.deepEqual(offsets, [0, 20, 40, 60, 80, 100, 120]);
});

test('Growi ページ列挙は同じ20件しか返らず進捗が止まると警告して中断する', async () => {
  const batch = Array.from({ length: 20 }, (_, index) => ({ _id: `page-${index}` }));
  let calls = 0;
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const result = await listGrowiPages('https://growi.example', async () => {
      calls++;
      return new Response(JSON.stringify({ data: { pages: batch, totalCount: 130 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }, 500);
    assert.equal(result.pages.length, 20);
  } finally {
    console.error = originalError;
  }
  assert.equal(calls, 4);
  assert.ok(errors.some((line) => line.includes('追加パスでも新規ページが増えなかった')));
});

test('Growi ページ列挙は更新順が動いて1パス目で欠落しても追加パスで全件を集める', async () => {
  const all = Array.from({ length: 6 }, (_, index) => ({ _id: `page-${index}`, path: `/page-${index}` }));
  const firstPass = [[all[0], all[1]], [all[3], all[4]], [all[5]]];
  const secondPass = [[all[0], all[1]], [all[2], all[3]], [all[4], all[5]]];
  let pass = -1;
  const offsets = [];
  const http = async (url) => {
    const offset = Number(new URL(url).searchParams.get('offset'));
    if (offset === 0) pass++;
    offsets.push([pass, offset]);
    const batches = pass === 0 ? firstPass : secondPass;
    const batch = batches[offset === 0 ? 0 : offset === 2 ? 1 : 2] ?? [];
    return new Response(JSON.stringify({ data: { pages: batch, totalCount: 6 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await listGrowiPages('https://growi.example', http, 2);
  assert.equal(result.pages.length, 6);
  assert.deepEqual(new Set(result.pages.map((page) => page._id)), new Set(all.map((page) => page._id)));
  assert.ok(offsets.some(([passNumber]) => passNumber === 1));
});

test('Growi ページ列挙は追加パスで増えなければ警告して収集済みで継続する', async () => {
  const visible = Array.from({ length: 4 }, (_, index) => ({ _id: `page-${index}` }));
  const errors = [];
  const originalError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    const result = await listGrowiPages('https://growi.example', async (url) => {
      const offset = Number(new URL(url).searchParams.get('offset'));
      return new Response(JSON.stringify({ data: { pages: visible.slice(offset, offset + 2), totalCount: 5 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }, 2);
    assert.equal(result.pages.length, 4);
  } finally {
    console.error = originalError;
  }
  assert.ok(errors.some((line) => line.includes('追加パスでも新規ページが増えなかった')));
  assert.ok(errors.some((line) => line.includes('収集 4 / totalCount 5（追加パス 1 回）')));
});

test('syncGrowi は writeParts 使用時に既定で発行せず、publish: true のときだけ発行する', async (t) => {
  const cache = temporaryCache(t);
  const page = { _id: 'page-1', path: '/部署/ページ1', updatedAt: 'now' };
  let writtenParts;
  const http = async (url, options = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === '/login' && !options.method) return new Response('<main csrftoken="csrf"></main>', { status: 200 });
    if (pathname === '/login') return new Response(null, { status: 302 });
    if (pathname.endsWith('/pages/recent')) return new Response(JSON.stringify({ data: { pages: [page], totalCount: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (pathname.endsWith('/revisions/list')) return new Response(JSON.stringify({ data: { docs: [{ body: '本文' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
    throw new Error(`想定外の HTTP 呼び出し: ${url}`);
  };
  let publishCalls = 0;
  const common = {
    cacheDir: cache,
    env: { GROWI_BASE_URL: 'https://growi.example', GROWI_USER: 'user', GROWI_PASS: 'pass' },
    http,
    writeParts: async (parts) => {
      writtenParts = parts;
      return new Map([[1, { fileId: 'mock-file', title: 'mock-title' }]]);
    },
    publishIndex: async (publishedCacheDir) => { publishCalls++; assert.equal(publishedCacheDir, cache); return 0; },
  };
  const code = await syncGrowi(common);
  assert.equal(code, 0);
  assert.equal(publishCalls, 0);
  assert.equal(writtenParts.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(cache, 'meta.json'), 'utf8')).parts[0].fileId, 'mock-file');
  assert.equal(await syncGrowi({ ...common, publish: true }), 0);
  assert.equal(publishCalls, 1);
});

test('publishIndex は指定された cacheDir の索引を発行する', async (t) => {
  const cache = temporaryCache(t);
  fs.writeFileSync(path.join(cache, 'part01.txt'), sample());
  buildIndex(cache);
  fs.appendFileSync(path.join(cache, 'index.tsv'), 'scratch-cache-marker\n');
  const uploads = [];
  const auth = {
    defaultDriveKeyPath: () => tool,
    getDriveToken: async () => 'token',
    driveApi: async (_token, url, options = {}) => {
      if (!options.method) return new Response(JSON.stringify({ files: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      uploads.push(Buffer.from(options.body).toString('utf8'));
      return new Response(JSON.stringify({ id: `uploaded-${uploads.length}` }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
  assert.equal(await publishIndex(cache, auth), 0);
  assert.equal(uploads.length, 2);
  assert.ok(uploads.some((body) => body.includes('scratch-cache-marker')));
});

test('差分取得は updatedAt が同じページの本文 API を呼ばない', async () => {
  const pages = [
    { _id: 'same', path: '/同じ', updatedAt: '2026-09-01' },
    { _id: 'new', path: '/新規', updatedAt: '2026-09-02' },
  ];
  const requested = [];
  const http = async (url) => {
    requested.push(url);
    return new Response(JSON.stringify({ data: { docs: [{ body: '新しい本文' }] } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const result = await fetchGrowiBodies(pages, { same: { path: '/同じ', updatedAt: '2026-09-01', body: 'キャッシュ本文' } }, {
    baseUrl: 'https://growi.example', http, retryDelay: async () => {},
  });
  assert.equal(requested.length, 1);
  assert.match(requested[0], /pageId=new/);
  assert.equal(result.records.same.body, 'キャッシュ本文');
});

test('本文取得は連続失敗が20件を超えると中断する', async () => {
  const pages = Array.from({ length: 30 }, (_, index) => ({ _id: `p${index}`, path: `/p${index}`, updatedAt: 'now' }));
  let calls = 0;
  const http = async () => { calls++; return new Response('error', { status: 500 }); };
  await assert.rejects(fetchGrowiBodies(pages, {}, {
    baseUrl: 'https://growi.example', http, concurrency: 1, retryDelay: async () => {},
  }), /20件を超えたため中断/);
  assert.equal(calls, 63);
});

test('生成した CRLF・BOM の Part は parsePart で全ページを再パースできる', () => {
  const pages = Array.from({ length: 5 }, (_, index) => ({ _id: `p${index}`, path: `/部署/ページ${index}`, updatedAt: 'now' }));
  const records = Object.fromEntries(pages.map((page, index) => [page._id, { ...page, body: `本文${index}\n二行目` }]));
  const parts = generateGrowiParts(pages, records, { targetChars: 130, now: new Date('2026-09-06T00:00:00Z') });
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.startsWith('\uFEFF') && part.includes('\r\n')));
  assert.equal(parts.reduce((sum, part, index) => sum + parsePart(part, index + 1).pages.length, 0), pages.length);
});
