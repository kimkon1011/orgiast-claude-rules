import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(toolsDir, '..');
const script = path.join(toolsDir, 'competitor-content-structure.mjs');

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { cwd: repoDir, encoding: 'utf8' });
}

test('dry-run produces markdown output', () => {
  const result = run(['--dry-run']);
  assert.equal(result.status, 0, result.stderr);
  // Must have standard sections
  assert.match(result.stdout, /競合コンテンツ構造分析レポート/);
  assert.match(result.stdout, /分析対象競合/);
  assert.match(result.stdout, /ページ構造分析/);
  assert.match(result.stdout, /キーワードギャップ分析/);
  assert.match(result.stdout, /推奨アクション一覧/);
  assert.match(result.stdout, /競合詳細データ/);
});

test('dry-run with industry option', () => {
  const result = run(['--dry-run', '--industry', '製造業']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /製造業/);
});

test('output file is created', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'competitor-test-'));
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));
  const outFile = path.join(tmpDir, 'test-report.md');
  const result = run(['--dry-run', '--output', outFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fs.existsSync(outFile));
  const content = fs.readFileSync(outFile, 'utf-8');
  assert.match(content, /競合コンテンツ構造分析レポート/);
});

test('help flag displays usage', () => {
  const result = run(['--help']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /competitor-content-structure/);
  assert.match(result.stdout, /--industry/);
  assert.match(result.stdout, /--dry-run/);
});

test('competitor data has all required fields', () => {
  // Import and validate the competitor database structure
  const result = run(['--dry-run']);
  assert.equal(result.status, 0);
  // Verify all 4 competitors appear
  assert.match(result.stdout, /リオエンターテイメントデザイン/);
  assert.match(result.stdout, /SUPER PENGUIN/);
  assert.match(result.stdout, /東京展飾/);
  assert.match(result.stdout, /ゼンシン/);
});

test('keyword gaps are identified', () => {
  const result = run(['--dry-run']);
  assert.equal(result.status, 0);
  // Should find at least one opportunity gap
  assert.match(result.stdout, /未開拓領域|独自差別化領域/);
});

test('page structure analysis identifies must-have sections', () => {
  const result = run(['--dry-run']);
  assert.equal(result.status, 0);
  // Should identify CTA as must-have (100% of competitors have it)
  assert.match(result.stdout, /CTA/);
  // Must Have section should exist
  assert.match(result.stdout, /Must Have/);
});

test('recommendations are generated', () => {
  const result = run(['--dry-run']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /推奨アクション一覧/);
  // Should have priority levels
  assert.match(result.stdout, /優先度/);
  assert.match(result.stdout, /高/);
});

test('top opportunities section exists', () => {
  const result = run(['--dry-run']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /キーワードギャップ分析/);
});

test('competitor details section is complete', () => {
  const result = run(['--dry-run']);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /競合詳細データ/);
  // Each competitor should have URL and features
  assert.match(result.stdout, /URL/);
  assert.match(result.stdout, /強み/);
  assert.match(result.stdout, /弱み/);
});
