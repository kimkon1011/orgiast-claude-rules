import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { readFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DB = join(__dirname, '..', 'outputs', 'X-0017', 'cache-records.jsonl');

describe('X-0017 プロンプトキャッシュユーティリティ', () => {
  before(() => {
    // Clean test DB - ensure directory exists
    mkdirSync(dirname(CACHE_DB), { recursive: true });
    if (existsSync(CACHE_DB)) {
      try { unlinkSync(CACHE_DB); } catch { /* ignore */ }
    }
  });

  after(() => {
    // Clean test DB
    if (existsSync(CACHE_DB)) {
      try { unlinkSync(CACHE_DB); } catch { /* ignore */ }
    }
  });

  it('--check で全6項目のチェックリストを出力する', () => {
    const result = spawnSync('node', [
      join(__dirname, 'x0017-prompt-cache-usage.mjs'),
      '--check',
    ], { encoding: 'utf-8', cwd: join(__dirname, '..') });

    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('モデル切替'), 'モデル切替の項目を含む');
    assert.ok(result.stdout.includes('長時間中断'), '長時間中断の項目を含む');
    assert.ok(result.stdout.includes('コンパクトのタイミング'), 'コンパクトの項目を含む');
    assert.ok(result.stdout.includes('システムプロンプトの活用'), 'システムプロンプトの項目を含む');
    assert.ok(result.stdout.includes('セッション1目的'), 'セッション1目的の項目を含む');
    assert.ok(result.stdout.includes('ヒット率確認'), 'ヒット率確認の項目を含む');
    assert.ok(result.stdout.includes('全6項目'), '6項目と表示');
  });

  it('--record で記録を保存する', () => {
    const result = spawnSync('node', [
      join(__dirname, 'x0017-prompt-cache-usage.mjs'),
      '--record', '--hit-rate', '81', '--session', 'test-session-001', '--note', 'テスト記録',
    ], { encoding: 'utf-8', cwd: join(__dirname, '..') });

    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('記録完了'));
    assert.ok(result.stdout.includes('良好なキャッシュ利用率'));

    // Verify saved
    const records = readFileSync(CACHE_DB, 'utf-8').trim().split('\n');
    assert.ok(records.length >= 1);
    const record = JSON.parse(records[records.length - 1]);
    assert.strictEqual(record.hitRate, 81);
    assert.strictEqual(record.session, 'test-session-001');
  });

  it('--record のヒット率50%未満で警告アクションを出す', () => {
    const result = spawnSync('node', [
      join(__dirname, 'x0017-prompt-cache-usage.mjs'),
      '--record', '--hit-rate', '30', '--session', 'low-cache',
    ], { encoding: 'utf-8', cwd: join(__dirname, '..') });

    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('キャッシュが機能していません'));
    assert.ok(result.stdout.includes('モデル切替'));
    assert.ok(result.stdout.includes('長時間中断'));
  });

  it('--report で保存した記録を表示する', () => {
    const result = spawnSync('node', [
      join(__dirname, 'x0017-prompt-cache-usage.mjs'),
      '--report',
    ], { encoding: 'utf-8', cwd: join(__dirname, '..') });

    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('2件の記録'));
    assert.ok(result.stdout.includes('平均ヒット率'));
  });

  it('引数なしでヘルプを表示する', () => {
    const result = spawnSync('node', [
      join(__dirname, 'x0017-prompt-cache-usage.mjs'),
    ], { encoding: 'utf-8', cwd: join(__dirname, '..') });

    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('使用方法'));
  });

  it('--record のみ（--hit-rate不足）でエラー終了する', () => {
    const result = spawnSync('node', [
      join(__dirname, 'x0017-prompt-cache-usage.mjs'),
      '--record',
    ], { encoding: 'utf-8', cwd: join(__dirname, '..') });

    assert.strictEqual(result.status, 1);
    assert.ok(result.stderr.includes('--hit-rate'));
  });

  it('空の状態で--reportを実行すると「記録なし」と表示する', () => {
    // Remove test DB to simulate empty state
    if (existsSync(CACHE_DB)) {
      try { unlinkSync(CACHE_DB); } catch { /* ignore */ }
    }

    const result = spawnSync('node', [
      join(__dirname, 'x0017-prompt-cache-usage.mjs'),
      '--report',
    ], { encoding: 'utf-8', cwd: join(__dirname, '..') });

    assert.strictEqual(result.status, 0);
    assert.ok(result.stdout.includes('記録なし'));
  });
});