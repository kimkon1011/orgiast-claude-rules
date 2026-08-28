import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildIndex, ingestFiles, parsePart } from './growi-manual.mjs';

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

test('引数なしは usage を stderr に出して exit 2', (t) => {
  const result = run(temporaryCache(t), []);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
});
