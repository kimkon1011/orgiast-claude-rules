// site-test-runner.test.mjs — テストランナーのテスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runAllSuites, runSelectedSuites, runSuitesForChangeType } from './site-test-runner.mjs';

const EMPTY_DATA = {
  html: '',
  links: [],
  meta: { title: '', description: '', h1Count: 0, hasCanonical: false, hasOgTitle: false },
  perf: { htmlSize: 0, imageCount: 0 },
  structure: { headings: [], images: [] },
  wcag: [],
};

describe('runAllSuites', () => {
  it('全6スイートが実行される', () => {
    const result = runAllSuites('https://example.com', EMPTY_DATA);
    assert.equal(result.url, 'https://example.com');
    assert.ok(result.timestamp);
    assert.equal(result.results.length, 6);
    assert.ok(result.results.every(r => ['html-valid', 'links', 'seo-meta', 'performance', 'structure', 'wcag-basic'].includes(r.suite)));
  });

  it('overall が pass/fail/warn のいずれか', () => {
    const result = runAllSuites('https://example.com', EMPTY_DATA);
    assert.ok(['pass', 'fail', 'warn'].includes(result.overall));
  });

  it('妥当なHTMLでoverall pass', () => {
    const data = {
      html: '<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="w"><title>T</title></head><body><h1>H</h1><main>M</main></body></html>',
      links: [{ href: 'https://example.com/page1', text: 'link1' }],
      meta: { title: '展示会ブース制作の費用と種類まとめ｜集客デザインの考え方2026年', description: 'a'.repeat(140), h1Count: 1, hasCanonical: true, hasOgTitle: true },
      perf: { htmlSize: 10000, imageCount: 5 },
      structure: { headings: [{ level: 1, text: 'H' }, { level: 2, text: 'H2' }], images: [{ hasAlt: true }] },
      wcag: [{ tag: 'a', hasAlt: false, tabindex: 0 }, { tag: 'img', hasAlt: true, tabindex: -1 }],
    };
    const result = runAllSuites('https://example.com', data);
    assert.equal(result.overall, 'pass');
  });
});

describe('runSelectedSuites', () => {
  it('指定スイートのみ実行', () => {
    const result = runSelectedSuites(['html-valid', 'seo-meta'], 'https://example.com', EMPTY_DATA);
    assert.equal(result.results.length, 2);
    assert.equal(result.results[0].suite, 'html-valid');
    assert.equal(result.results[1].suite, 'seo-meta');
  });

  it('不明なスイートでエラー', () => {
    assert.throws(() => {
      runSelectedSuites(['nonexistent'], 'https://example.com', EMPTY_DATA);
    }, /不明なスイート/);
  });

  it('空配列でエラー', () => {
    assert.throws(() => {
      runSelectedSuites([], 'https://example.com', EMPTY_DATA);
    }, /suiteNames は空でない配列/);
  });
});

describe('runSuitesForChangeType', () => {
  it('text が正しいスイートを選択', () => {
    const result = runSuitesForChangeType('text', 'https://example.com', EMPTY_DATA);
    assert.equal(result.results.length, 4);
    const suites = result.results.map(r => r.suite);
    assert.ok(suites.includes('html-valid'));
    assert.ok(suites.includes('seo-meta'));
    assert.ok(suites.includes('structure'));
    assert.ok(suites.includes('wcag-basic'));
    assert.ok(!suites.includes('links'));
    assert.ok(!suites.includes('performance'));
  });

  it('full が全スイートを選択', () => {
    const result = runSuitesForChangeType('full', 'https://example.com', EMPTY_DATA);
    assert.equal(result.results.length, 6);
  });

  it('不明な種別でエラー', () => {
    assert.throws(() => {
      runSuitesForChangeType('invalid', 'https://example.com', EMPTY_DATA);
    }, /不明な変更種別/);
  });

  it('link 変更種別でリンクスイート含む', () => {
    const result = runSuitesForChangeType('link', 'https://example.com', EMPTY_DATA);
    const suites = result.results.map(r => r.suite);
    assert.ok(suites.includes('links'));
    assert.ok(suites.includes('html-valid'));
  });
});