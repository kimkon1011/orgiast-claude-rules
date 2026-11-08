import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { extractQueries, summarizeResults, splitSentences } from './ai-query-extract.mjs';

const script = path.resolve('tools/ai-query-extract.mjs');

// ─── 文分割 ──────────────────────────────────────────────────────
test('splitSentences: 空文字は空配列', () => {
  assert.deepEqual(splitSentences(''), []);
  assert.deepEqual(splitSentences(null), []);
  assert.deepEqual(splitSentences(undefined), []);
});

test('splitSentences: 句点で分割する', () => {
  const result = splitSentences('今日は良い天気です。明日も晴れるでしょうか。明後日は雨らしい。');
  assert.equal(result.length, 3);
  assert.match(result[0], /今日/);
  assert.match(result[1], /明日/);
  assert.match(result[2], /明後日/);
});

test('splitSentences: 疑問符・改行でも分割する', () => {
  const result = splitSentences('こんにちは？\n元気ですか！\nさようなら。');
  assert.equal(result.length, 3);
});

// ─── 疑問文系 ─────────────────────────────────────────────────────
test('疑問符で終わる文を抽出する', () => {
  const results = extractQueries('展示会の申し込みはいつまでですか？');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'question');
});

test('疑問詞を含む文を抽出する', () => {
  // 「知りたいです」は末尾が「す」なので「です」マッチで検出される
  const results = extractQueries('なぜこのブースデザインが選ばれたのですか？');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'question');
  assert.ok(results[0].matchedPatterns.question.length > 0);
});

test('丁寧な疑問文を抽出する（可能ですか）', () => {
  const results = extractQueries('3m小間での施工は可能ですか？');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'question');
});

test('文末疑問形（でしょうか）を抽出する', () => {
  // 「でしょうか。」は Q_END で「。」を許容するのでマッチする
  const results = extractQueries('予算内で収まるものでしょうか。');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'question');
});

test('文末疑問形（疑問符あり）を抽出する', () => {
  const results = extractQueries('予算内で収まるものでしょうか？');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'question');
});

test('条件疑問を抽出する', () => {
  const results = extractQueries('急ぎの案件の場合、納期はどのくらいかかりますか？');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'question');
});

// ─── 依頼文系 ─────────────────────────────────────────────────────
test('〜てください を抽出する', () => {
  const results = extractQueries('見積書を送ってください。');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'request');
  assert.ok(results[0].matchedPatterns.request.includes('〜てください'));
});

test('〜お願いします を抽出する', () => {
  const results = extractQueries('資料の送付をお願いします。');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'request');
  assert.ok(results[0].matchedPatterns.request.some((p) => p.includes('お願い')));
});

test('〜教えて を抽出する', () => {
  const results = extractQueries('展示会の出展手順を教えてください。');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'request');
});

test('〜知りたい を抽出する', () => {
  const results = extractQueries('他社のブース事例について知りたい。');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'request');
});

test('〜してほしい を抽出する', () => {
  const results = extractQueries('デザイン案を3パターン出してほしい。');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'request');
});

test('〜見積もり を抽出する', () => {
  const results = extractQueries('3m×3m小間の見積もりお願いします。');
  assert.equal(results.length, 1);
  // 「お願いします」パターンと「見積もり」パターンの両方
  assert.ok(results[0].matchedPatterns.request.length > 0);
});

// ─── 複合 ─────────────────────────────────────────────────────────
test('疑問と依頼の両方にマッチする文を both と判定する', () => {
  const results = extractQueries('見積書を送っていただけますか？');
  assert.equal(results.length, 1);
  assert.equal(results[0].type, 'both');
  assert.ok(results[0].matchedPatterns.question.length > 0);
  assert.ok(results[0].matchedPatterns.request.length > 0);
});

test('疑問文でない平叙文は抽出しない', () => {
  const results = extractQueries('本日の展示会は盛況でした。');
  assert.equal(results.length, 0);
});

test('複数の文から混合タイプを抽出する', () => {
  const text = [
    '展示会ブースの見積もりをお願いします。',
    '納期はどのくらいですか？',
    '本日はありがとうございました。',
    'デザイン案を送っていただけますか？',
  ].join('');
  const results = extractQueries(text);
  assert.equal(results.length, 3);
  const types = results.map((r) => r.type);
  assert.ok(types.includes('request'));
  assert.ok(types.includes('question'));
  assert.ok(types.includes('both'));
});

// ─── 統計 ─────────────────────────────────────────────────────────
test('summarizeResults が正しい集計を返す', () => {
  const results = [
    { text: 'test1', type: 'question', matchedPatterns: { question: ['疑問符'], request: [] } },
    { text: 'test2', type: 'request', matchedPatterns: { question: [], request: ['〜てください'] } },
    { text: 'test3', type: 'both', matchedPatterns: { question: ['疑問符'], request: ['〜お願い'] } },
    { text: 'test4', type: 'question', matchedPatterns: { question: ['疑問詞'], request: [] } },
  ];
  const summary = summarizeResults(results);
  assert.equal(summary.total, 4);
  assert.equal(summary.questions, 2);
  assert.equal(summary.requests, 1);
  assert.equal(summary.both, 1);
  assert.ok(summary.topPatterns.length > 0);
});

// ─── CLI ─────────────────────────────────────────────────────────
test('CLI: 空入力はusageを表示する', () => {
  const output = execFileSync(process.execPath, [script], { encoding: 'utf-8', timeout: 5000 });
  assert.match(output, /使用方法/);
});

test('CLI: ファイル入力で抽出する', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-query-test-'));
  const testFile = path.join(tmpDir, 'test-input.txt');
  fs.writeFileSync(testFile, '見積もりをお願いします。\n納期はいつですか？\n今日はいい天気ですね。\n');
  try {
    const output = execFileSync(process.execPath, [script, testFile], { encoding: 'utf-8', timeout: 5000 });
    assert.match(output, /見積もり/);
    assert.match(output, /納期/);
    assert.match(output, /合計/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: --summary で集計表示する', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-query-test-'));
  const testFile = path.join(tmpDir, 'test-input.txt');
  fs.writeFileSync(testFile, '見積もりをお願いします。\n納期はいつですか？\n');
  try {
    const output = execFileSync(process.execPath, [script, testFile, '--summary'], { encoding: 'utf-8', timeout: 5000 });
    assert.match(output, /疑問文系/);
    assert.match(output, /依頼文系/);
    assert.match(output, /抽出クエリ/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI: --json でJSON出力する', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-query-test-'));
  const testFile = path.join(tmpDir, 'test-input.txt');
  fs.writeFileSync(testFile, '見積もりをお願いします。\n納期はいつですか？\n');
  try {
    const output = execFileSync(process.execPath, [script, testFile, '--json'], { encoding: 'utf-8', timeout: 5000 });
    const parsed = JSON.parse(output);
    assert.equal(parsed.count, 2);
    assert.ok(Array.isArray(parsed.results));
    assert.ok(parsed.summary);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
