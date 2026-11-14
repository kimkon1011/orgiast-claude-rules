import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  analyzeQuestion, buildCrossTab, detectBrands, loadQuestions, parseArgs, runCli,
} from './brand-mention-analyzer.mjs';

test('ブランド検出: 完全一致', () => {
  assert.equal(detectBrands('おすすめはオージャストです', ['オージャスト'])[0].mentioned, true);
  assert.equal(detectBrands('おすすめはオージャストです', ['オージャスト'])[0].exactMatch, true);
});

test('ブランド検出: 会社表記を部分一致として検出', () => {
  const result = detectBrands('オージャスト株式会社と（株）リブース', ['オージャスト', 'リブース']);
  assert.equal(result[0].partialMatch, true);
  assert.equal(result[1].partialMatch, true);
});

test('ブランド検出: URLドメイン一致', () => {
  const result = detectBrands('詳細: https://www.orgiast.jp/service/booth', ['オージャスト'])[0];
  assert.equal(result.urlMatch, true);
  assert.equal(result.mentioned, true);
});

test('ブランド未検出', () => {
  assert.deepEqual(detectBrands('別の会社です', ['オージャスト'])[0], {
    brand: 'オージャスト', mentioned: false, exactMatch: false, partialMatch: false, urlMatch: false, count: 0,
  });
});

test('クロス集計', () => {
  const results = [
    { provider: 'gemini', brands: [{ brand: 'オージャスト', mentioned: true }] },
    { provider: 'groq', brands: [{ brand: 'オージャスト', mentioned: false }] },
  ];
  assert.deepEqual(buildCrossTab(results, ['オージャスト'], ['gemini', 'groq']), {
    オージャスト: { gemini: true, groq: false, appearanceRate: '1/2' },
  });
});

test('CLI引数パースと競合追加', () => {
  const args = parseArgs(['--question', '質問', '--brand', '自社', '--competitors', '競合A,競合B', '--providers', 'gemini,groq', '--output', 'json']);
  assert.deepEqual(args.competitors, ['競合A', '競合B']);
  assert.deepEqual(args.providers, ['gemini', 'groq']);
  assert.equal(args.brand, '自社');
  assert.equal(args.output, 'json');
});

test('必須フラグ不足はエラー出力', async () => {
  let stdout = '', stderr = '';
  const code = await runCli([], { stdout: { write: value => { stdout += value; } }, stderr: { write: value => { stderr += value; } } });
  assert.equal(code, 1);
  assert.equal(stdout, '');
  assert.match(stderr, /--question/);
});

test('競合ブランドを分析対象に追加', async () => {
  const report = await analyzeQuestion({
    question: '質問', competitors: ['クラフト'], providers: ['gemini'],
    ask: async () => 'クラフトをおすすめします', timestamp: '2026-11-10T00:00:00.000Z',
  });
  assert.equal(report.crossTab.クラフト.gemini, true);
});

test('質問CSV読み込み（引用符と未引用の競合列）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'brand-mention-'));
  const file = path.join(dir, 'questions.csv');
  try {
    fs.writeFileSync(file, '\uFEFFquestion,category,brand,competitors\r\n"質問, その1",分類,自社,"競合A,競合B"\r\n質問2,分類,自社,競合C,競合D\r\n', 'utf8');
    const rows = loadQuestions(file);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].question, '質問, その1');
    assert.equal(rows[0].competitors, '競合A,競合B');
    assert.equal(rows[1].competitors, '競合C,競合D');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('JSON出力フォーマット相当のレポートはJSON化・復元できる', async () => {
  const report = await analyzeQuestion({
    question: '展示会ブース制作', providers: ['gemini', 'groq'],
    ask: async provider => provider === 'gemini' ? 'オージャスト https://orgiast.jp' : 'リブース',
    timestamp: '2026-11-10T00:00:00.000Z',
  });
  const parsed = JSON.parse(JSON.stringify(report));
  assert.equal(parsed.question, '展示会ブース制作');
  assert.equal(parsed.results.length, 2);
  assert.equal(parsed.crossTab.オージャスト.appearanceRate, '1/2');
});

test('一部プロバイダの失敗はエラー結果として残す', async () => {
  const report = await analyzeQuestion({
    question: '質問', providers: ['gemini', 'groq'],
    ask: async provider => { if (provider === 'gemini') throw new Error('timeout'); return 'リブース'; },
  });
  assert.match(report.results[0].error, /timeout/);
  assert.equal(report.results[1].brands.find(item => item.brand === 'リブース').mentioned, true);
});

test('全プロバイダ失敗はエラー', async () => {
  await assert.rejects(() => analyzeQuestion({ question: '質問', providers: ['gemini'], ask: async () => { throw new Error('down'); } }), /全プロバイダ/);
});
