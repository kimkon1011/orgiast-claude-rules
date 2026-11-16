#!/usr/bin/env node
/**
 * tools/interview-article-gen.test.mjs — X-0033 テスト
 *
 * 使い方:
 *   node --test tools/interview-article-gen.test.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import {
  sampleQaPairs,
  articleToMarkdown,
  QUESTION_CATEGORIES,
} from './interview-article-gen.mjs';

// ============================================================
// テストヘルパー
// ============================================================

function assert(condition, label) {
  if (!condition) throw new AssertionError(`FAIL: ${label}`);
  console.log(`  ✅ ${label}`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new AssertionError(`FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  console.log(`  ✅ ${label}`);
}

function assertMatch(text, regex, label) {
  if (!regex.test(String(text))) throw new AssertionError(`FAIL: ${label} — ${JSON.stringify(text).slice(0,80)} does not match ${regex}`);
  console.log(`  ✅ ${label}`);
}

// ============================================================
// テスト
// ============================================================

async function testSampleQaPairs() {
  console.log('\n--- testSampleQaPairs');

  const qaPairs = sampleQaPairs();
  assert(qaPairs.length >= 20, `サンプルQAは20問以上: ${qaPairs.length}問`);
  assert(qaPairs.every(q => typeof q.question === 'string' && q.question.length > 10), '各質問が文字列かつ十分な長さ');
  assert(qaPairs.every(q => typeof q.answer === 'string' && q.answer.length > 20), '各回答が文字列かつ十分な長さ');
  assert(qaPairs.every(q => q.question.includes('？') || q.question.includes('?')), '各質問に疑問符が含まれる');
}

async function testQuestionCategories() {
  console.log('\n--- testQuestionCategories');

  const total = QUESTION_CATEGORIES.reduce((sum, c) => sum + c.count, 0);
  assertEqual(total, 24, `カテゴリ合計は24問: ${total}問`);
  assertEqual(QUESTION_CATEGORIES.length, 6, 'カテゴリは6つ');
  assert(QUESTION_CATEGORIES.every(c => c.key && c.label && c.count > 0 && c.purpose), '各カテゴリに必須フィールドがある');
}

async function testArticleToMarkdown() {
  console.log('\n--- testArticleToMarkdown');

  const sampleArticle = {
    title: 'テスト記事タイトル',
    lead: 'これはテストリード文です',
    sections: [
      { heading: 'セクション1', body: '本文1です。' },
      { heading: 'セクション2', body: '本文2です。' },
    ],
    faq: [
      { question: 'Q1ですか？', answer: 'A1です。' },
    ],
    metadata: {
      description: 'テスト用メタディスクリプション',
      keywords: ['キーワード1', 'キーワード2'],
    },
  };

  const md = articleToMarkdown(sampleArticle);
  assert(typeof md === 'string' && md.length > 50, 'Markdownが生成される');
  assert(md.includes('# テスト記事タイトル'), 'タイトルが含まれる');
  assert(md.includes('> これはテストリード文です'), 'リード文が含まれる（引用形式）');
  assert(md.includes('## セクション1'), 'h2見出しが含まれる');
  assert(md.includes('## よくある質問'), 'FAQセクションが含まれる');
  assert(md.includes('キーワード1'), 'キーワードが含まれる');
}

async function testEmptyArticleToMarkdown() {
  console.log('\n--- testEmptyArticleToMarkdown');

  const md = articleToMarkdown({ title: '最小構成', sections: [], metadata: { keywords: [] } });
  assert(md.includes('# 最小構成'), 'タイトルのみでもMarkdownが生成される');
}

// ============================================================
// エントリポイント
// ============================================================

if (isEntry(import.meta)) {
  const tests = [
    testSampleQaPairs,
    testQuestionCategories,
    testArticleToMarkdown,
    testEmptyArticleToMarkdown,
  ];

  let passed = 0;
  let failed = 0;

  console.log('X-0033 interview-article-gen テスト開始');
  for (const test of tests) {
    try {
      await test();
      passed++;
    } catch (err) {
      console.error(`  ❌ ${err.message}`);
      failed++;
    }
  }

  console.log(`\n${'='.repeat(40)}`);
  console.log(`結果: ${passed} passed, ${failed} failed / ${tests.length} total`);
  if (failed > 0) process.exit(1);
}