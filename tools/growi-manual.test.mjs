import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIndex, ingestFiles, installIndexFiles, parsePart } from './growi-manual.mjs';

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
