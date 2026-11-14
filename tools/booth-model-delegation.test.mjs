// generated-by: Sonnet
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens, initProject, roles } from './booth-model-delegation.mjs';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(toolsDir, 'booth-model-delegation.mjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'booth-model-delegation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('役割にSonnet、Haiku、Opusを含む', () => {
  assert.deepEqual(new Set(roles.map(({ model }) => model)), new Set(['Sonnet', 'Haiku', 'Opus']));
});

test('推定レポートは従来構成より少ない', () => {
  const report = estimateTokens();
  assert.equal(report.legacy.total, 26_000);
  assert.equal(report.delegated.total, 18_500);
  assert.equal(report.saved, 7_500);
  assert.equal(report.reductionPercent, 28.8);
});

test('--init相当は注釈付き4文書を作成し既存ファイルを上書きしない', (t) => {
  const baseDir = tempDir(t);
  const outputDir = initProject('C9999-demo', baseDir);
  const files = fs.readdirSync(outputDir);
  assert.equal(files.length, 4);
  for (const filename of files) assert.match(fs.readFileSync(path.join(outputDir, filename), 'utf8'), /^<!-- generated-by: (Sonnet|Haiku|Opus) -->/);
  const first = path.join(outputDir, '01_企画概要.md');
  fs.writeFileSync(first, '利用者の既存内容', 'utf8');
  initProject('C9999-demo', baseDir);
  assert.equal(fs.readFileSync(first, 'utf8'), '利用者の既存内容');
});

test('--demoはローカルで実行し役割を表示する', (t) => {
  const baseDir = tempDir(t);
  const result = spawnSync(process.execPath, [script, '--demo', '--project', 'C9998-demo', '--base-dir', baseDir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Sonnet: 企画概要/);
  assert.match(result.stdout, /Haiku: 過去事例調査/);
  assert.match(result.stdout, /Opus: 完了前確認/);
  assert.match(result.stdout, /外部LLM呼び出し: 0/);
});

test('--analyzeは推定削減を表示する', () => {
  const result = spawnSync(process.execPath, [script, '--analyze'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /推定削減: 7,500 tokens \(28\.8%\)/);
});

test('不正なプロジェクト名を拒否する', () => {
  assert.throws(() => initProject('../escape', os.tmpdir()), /プロジェクト名/);
});
