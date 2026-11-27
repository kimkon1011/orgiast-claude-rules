import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { main } from './booth-spec.mjs';

const sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data/booth-specs');

function capture() {
  let value = '';
  return { stream: { write(chunk) { value += chunk; } }, value: () => value };
}

async function run(args, specsDir) {
  const stdout = capture();
  const stderr = capture();
  const code = await main(args, { specsDir, stdout: stdout.stream, stderr: stderr.stream });
  return { code, stdout: stdout.value(), stderr: stderr.value() };
}

async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'booth-spec-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const id of ['C0056', 'C0062', 'C0068']) {
    await writeFile(path.join(dir, `${id}.json`), await readFile(path.join(sourceDir, `${id}.json`), 'utf8'));
  }
  return dir;
}

test('list: 全ファイルを表示する', async (t) => {
  const result = await run(['list'], await fixture(t));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /C0056/);
  assert.match(result.stdout, /C0062/);
  assert.match(result.stdout, /C0068/);
  assert.equal(result.stdout.trim().split('\n').length, 4);
});

test('list --industry: 指定業種に絞り込む', async (t) => {
  const result = await run(['list', '--industry', '環境素材・化学'], await fixture(t));
  assert.match(result.stdout, /C0062/);
  assert.doesNotMatch(result.stdout, /C0056|C0068/);
});

test('get: 既存IDをYAML-like形式で取得する', async (t) => {
  const result = await run(['get', 'C0056'], await fixture(t));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /^projectId: C0056/m);
  assert.match(result.stdout, /^  name: ものづくりワールド東京 2026/m);
});

test('get: 存在しないIDは終了コード1', async (t) => {
  const result = await run(['get', 'UNKNOWN'], await fixture(t));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /見つかりません/);
});

test('validate: 既存データが通過する', async (t) => {
  const result = await run(['validate'], await fixture(t));
  assert.equal(result.code, 0);
  assert.match(result.stdout, /エラー0件/);
});

test('validate: 不正JSONをエラーとして報告する', async (t) => {
  const dir = await fixture(t);
  await writeFile(path.join(dir, 'broken.json'), '{broken');
  const result = await run(['validate'], dir);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /broken\.json: JSONを読み込めません/);
  assert.match(result.stderr, /バリデーションエラー: 1件/);
});

test('add: 新規ファイルを追加する', async (t) => {
  const dir = await fixture(t);
  const input = path.join(dir, 'input.json');
  const data = { projectId: 'C9999', title: 'テスト', client: 'テスト社', industry: 'テスト', event: { name: 'テスト展' }, booth: { size: '3m×3m' }, period: '2026年', services: ['企画'], description: '説明' };
  await writeFile(input, JSON.stringify(data));
  const result = await run(['add', '--file', input], dir);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /追加しました/);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'C9999.json'), 'utf8')), data);
});

test('add: 重複IDを上書きして警告する', async (t) => {
  const dir = await fixture(t);
  const input = path.join(dir, 'replacement.json');
  const data = JSON.parse(await readFile(path.join(dir, 'C0056.json'), 'utf8'));
  data.title = '更新タイトル';
  await writeFile(input, JSON.stringify(data));
  const result = await run(['add', '--file', input], dir);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /上書きしました/);
  assert.equal(JSON.parse(await readFile(path.join(dir, 'C0056.json'), 'utf8')).title, '更新タイトル');
});

test('export json: JSON配列を出力する', async (t) => {
  const result = await run(['export', 'json'], await fixture(t));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).length, 3);
  assert.doesNotMatch(result.stdout, /\n  \{/);
});

test('export json --pretty: 整形したJSON配列を出力する', async (t) => {
  const result = await run(['export', 'json', '--pretty'], await fixture(t));
  assert.equal(result.code, 0);
  assert.equal(JSON.parse(result.stdout).length, 3);
  assert.match(result.stdout, /\n  \{/);
});
