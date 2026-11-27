#!/usr/bin/env node
/**
 * X-0099 長文クエリ → 見出し＋即答ツール テスト
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.resolve(__dirname, 'x0099-long-query-to-answer.mjs');
const DATA_DIR = path.resolve(__dirname, 'data');

// ─── ヘルパー ───

function run(args) {
  return execFileSync(process.execPath, [TOOL, ...args], {
    encoding: 'utf-8',
    maxBuffer: 2_000_000,
  });
}

// ─── テスト ───

describe('X-0099 長文クエリ判定', () => {
  it('isLongQuery: 日本語長文 (chars>=20) を検出する', () => {
    // 内部関数を直接呼べないので、ツールの出力で間接検証
    const sampleData = [
      { query: 'エネルギーをみんなにそしてクリーンに 取り組み', clicks: 20, impressions: 2335, ctr: 0.009, position: 2.7, page: 'https://www.orgiast.jp/topics/6610' },
      { query: '短い', clicks: 0, impressions: 10, ctr: 0, position: 30, page: 'https://www.orgiast.jp/' },
    ];
    const tmpJson = path.join(DATA_DIR, '.test-x0099-length.json');
    fs.writeFileSync(tmpJson, JSON.stringify(sampleData, null, 2));
    try {
      const out = run(['--input', tmpJson, '--mock', '--top', '5']);
      assert.ok(out.includes('長文該当行'), 'ヘッダが出力されること');
      assert.ok(out.includes('エネルギーをみんなに'), '長文クエリが含まれること');
    } finally {
      try { fs.unlinkSync(tmpJson); } catch { /* best effort */ }
    }
  });

  it('isLongQuery: 短いクエリは除外される', () => {
    const sampleData = [
      { query: '展示会', clicks: 10, impressions: 500, ctr: 0.02, position: 5, page: 'https://rebooth.co.jp/' },
      { query: '短いやつ', clicks: 0, impressions: 10, ctr: 0, position: 30, page: 'https://rebooth.co.jp/' },
    ];
    const tmpJson = path.join(DATA_DIR, '.test-x0099-short.json');
    fs.writeFileSync(tmpJson, JSON.stringify(sampleData, null, 2));
    try {
      const out = run(['--input', tmpJson, '--mock', '--top', '5']);
      // 両方とも短いので長文 = 0
      assert.ok(out.includes('長文該当行 | 0'), '長文該当行が0であること');
    } finally {
      try { fs.unlinkSync(tmpJson); } catch { /* best effort */ }
    }
  });

  it('--help で使用方法が表示される', () => {
    const out = run(['--help']);
    assert.ok(out.includes('X-0099 長文クエリ'), 'ヘルプのタイトルが表示されること');
    assert.ok(out.includes('--input'), '--input オプションが表示されること');
    assert.ok(out.includes('--mock'), '--mock オプションが表示されること');
  });

  it('--mock モードでモック応答が生成される', () => {
    const sampleData = [
      { query: '展示会 ブース 制作 費用 相場 2026', clicks: 5, impressions: 120, ctr: 0.04, position: 8, page: 'https://rebooth.co.jp/' },
    ];
    const tmpJson = path.join(DATA_DIR, '.test-x0099-mock.json');
    fs.writeFileSync(tmpJson, JSON.stringify(sampleData, null, 2));
    try {
      const out = run(['--input', tmpJson, '--mock', '--top', '5']);
      assert.ok(out.includes('モック応答'), 'モック応答が含まれること');
      assert.ok(out.includes('見出し案'), '見出し案の欄があること');
    } finally {
      try { fs.unlinkSync(tmpJson); } catch { /* best effort */ }
    }
  });

  it('--output でファイルに保存される', () => {
    const sampleData = [
      { query: '展示会 ブース デザイン サステナブル 素材 選び方', clicks: 0, impressions: 25, ctr: 0, position: 19.5, page: 'https://rebooth.co.jp/' },
    ];
    const tmpJson = path.join(DATA_DIR, '.test-x0099-output.json');
    const outFile = path.join(DATA_DIR, '.test-x0099-output.md');
    fs.writeFileSync(tmpJson, JSON.stringify(sampleData, null, 2));
    try {
      run(['--input', tmpJson, '--mock', '--output', outFile]);
      assert.ok(fs.existsSync(outFile), '出力ファイルが存在すること');
      const content = fs.readFileSync(outFile, 'utf-8');
      assert.ok(content.includes('X-0099'), 'レポートのタイトルが含まれること');
    } finally {
      try { fs.unlinkSync(tmpJson); } catch { /* best effort */ }
      try { fs.unlinkSync(outFile); } catch { /* best effort */ }
    }
  });

  it('収益意図クエリが正しく判定される', () => {
    const sampleData = [
      { query: '展示会 ブース 制作 費用 納期 比較', clicks: 3, impressions: 80, ctr: 0.038, position: 10, page: 'https://rebooth.co.jp/' },
      { query: 'SDGs 取り組み 事例', clicks: 10, impressions: 500, ctr: 0.02, position: 3, page: 'https://www.orgiast.jp/topics/6610' },
    ];
    const tmpJson = path.join(DATA_DIR, '.test-x0099-revenue.json');
    fs.writeFileSync(tmpJson, JSON.stringify(sampleData, null, 2));
    try {
      const out = run(['--input', tmpJson, '--mock', '--top', '5']);
      const lines = out.split('\n');
      // 1行目: 費用を含む → 💰 マーク
      // 2行目: SDGs → マークなし
      const revenueLine = lines.find(l => l.includes('展示会 ブース 制作 費用'));
      const sdgsLine = lines.find(l => l.includes('SDGs 取り組み'));
      assert.ok(revenueLine, '収益クエリ行が存在すること');
      assert.ok(revenueLine.includes('💰'), '収益クエリに💰マークが付くこと');
      if (sdgsLine) {
        assert.ok(!sdgsLine.includes('💰'), '非収益クエリに💰マークがないこと');
      }
    } finally {
      try { fs.unlinkSync(tmpJson); } catch { /* best effort */ }
    }
  });
});