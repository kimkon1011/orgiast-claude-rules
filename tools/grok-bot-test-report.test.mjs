// grok-bot-test-report.test.mjs — レポート生成のテスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateReport } from './grok-bot-test-report.mjs';

const PASS_RESULTS = [
  { suite: 'html-valid', status: 'pass', checks: Array(7).fill({ passed: true, name: 'dummy' }), summary: '7/7 checks passed' },
  { suite: 'links', status: 'pass', checks: [{ passed: true, name: 'dummy' }], summary: '3 links OK' },
];

const FAIL_RESULTS = [
  { suite: 'html-valid', status: 'pass', checks: Array(7).fill({ passed: true, name: 'dummy' }), summary: '7/7 checks passed' },
  { suite: 'seo-meta', status: 'fail', checks: [
    { passed: true, name: 'title長さ', detail: '42字' },
    { passed: false, name: 'canonical存在', detail: 'なし' },
  ], summary: '1 fail' },
];

const WARN_RESULTS = [
  { suite: 'html-valid', status: 'pass', checks: Array(7).fill({ passed: true, name: 'dummy' }), summary: '7/7 checks passed' },
  { suite: 'performance', status: 'warn', checks: [
    { passed: true, name: 'HTMLサイズ', detail: '10KB' },
    { passed: false, name: '画像数', detail: '25枚（超過）' },
  ], summary: '1 warning' },
];

describe('generateReport', () => {
  it('PASSのみで ✅ を含む', () => {
    const report = generateReport(PASS_RESULTS, { url: 'https://example.com' });
    assert.ok(report.includes('✅'));
    assert.ok(report.includes('PASS'));
    assert.ok(report.includes('example.com'));
  });

  it('FAILを含むで ❌ を含む', () => {
    const report = generateReport(FAIL_RESULTS, { url: 'https://example.com' });
    assert.ok(report.includes('❌'));
    assert.ok(report.includes('FAIL'));
  });

  it('WARNを含むで ⚠️ を含む', () => {
    const report = generateReport(WARN_RESULTS, { url: 'https://example.com' });
    assert.ok(report.includes('⚠️'));
    assert.ok(report.includes('WARN'));
  });

  it('空の結果配列でエラーにならない', () => {
    const report = generateReport([], { url: 'https://example.com' });
    assert.ok(report.includes('テストは実行されませんでした'));
  });

  it('URLと変更内容が含まれる', () => {
    const report = generateReport(PASS_RESULTS, {
      url: 'https://orgiast.jp/',
      changeDescription: 'トップページ更新'
    });
    assert.ok(report.includes('orgiast.jp'));
    assert.ok(report.includes('トップページ更新'));
  });

  it('全PASSでデプロイ推奨メッセージ', () => {
    const report = generateReport(PASS_RESULTS, { url: 'https://example.com' });
    assert.ok(report.includes('全テスト合格'));
    assert.ok(report.includes('デプロイ'));
  });

  it('プレビューURLが含まれる', () => {
    const report = generateReport(PASS_RESULTS, {
      url: 'https://example.com',
      previewUrl: 'https://preview.example.com/123'
    });
    assert.ok(report.includes('preview.example.com'));
  });

  it('スイート名がレポートに含まれる', () => {
    const report = generateReport(PASS_RESULTS, { url: 'https://example.com' });
    assert.ok(report.includes('html-valid'));
    assert.ok(report.includes('links'));
  });

  it('不合格チェックの詳細が含まれる（FAIL時）', () => {
    const report = generateReport(FAIL_RESULTS, { url: 'https://example.com' });
    assert.ok(report.includes('canonical存在'));
  });

  it('options未指定でもエラーにならない', () => {
    const report = generateReport(PASS_RESULTS);
    assert.ok(report);
  });
});