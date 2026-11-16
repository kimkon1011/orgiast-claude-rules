#!/usr/bin/env node
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  parseCsv,
  csvRowsToObjects,
  selectTestPages,
  compareSnapshots,
  generatePlanReport,
  generateComparisonReport,
  generateAiCitationReport,
  generateAiCitationTracker,
  makeMockPages,
  makeMockAfterPages,
} from '../tools/seo-small-page-test.mjs';

describe('seo-small-page-test (X-0049)', () => {
  describe('parseCsv', () => {
    it('parses simple CSV', () => {
      const csv = 'a,b,c\n1,2,3\n4,5,6';
      assert.deepEqual(parseCsv(csv), [['a', 'b', 'c'], ['1', '2', '3'], ['4', '5', '6']]);
    });

    it('handles quoted fields', () => {
      const csv = 'a,"b,c",d\n1,2,3';
      assert.deepEqual(parseCsv(csv), [['a', 'b,c', 'd'], ['1', '2', '3']]);
    });

    it('handles CRLF line endings', () => {
      const csv = 'a,b\r\n1,2\r\n';
      assert.deepEqual(parseCsv(csv), [['a', 'b'], ['1', '2']]);
    });
  });

  describe('csvRowsToObjects', () => {
    it('converts rows to objects', () => {
      const rows = [['URL', 'Clicks', 'Impressions'], ['/page1', '10', '100'], ['/page2', '5', '50']];
      const objs = csvRowsToObjects(rows);
      assert.equal(objs.length, 2);
      assert.equal(objs[0].url, '/page1');
      assert.equal(objs[0].clicks, '10');
      assert.equal(objs[1].impressions, '50');
    });

    it('returns empty array for header only', () => {
      assert.deepEqual(csvRowsToObjects([['a', 'b']]), []);
    });
  });

  describe('selectTestPages', () => {
    const pages = [
      { url: 'https://orgiast.jp/event/booth-construction', clicks: '45', impressions: '2340', ctr: '1.92', position: '8.5' },
      { url: 'https://orgiast.jp/event/exhibition', clicks: '32', impressions: '1890', ctr: '1.69', position: '12.3' },
      { url: 'https://orgiast.jp/event/booth-cost', clicks: '67', impressions: '3420', ctr: '1.96', position: '6.8' },
      { url: 'https://orgiast.jp/event/promotion', clicks: '15', impressions: '890', ctr: '1.69', position: '18.4' },
      { url: 'https://orgiast.jp/event/top', clicks: '3', impressions: '200', ctr: '1.50', position: '4.2' },   // 範囲外（4.2 < 5）
      { url: 'https://orgiast.jp/event/deep', clicks: '2', impressions: '150', ctr: '1.33', position: '25.0' },  // 範囲外（25 > 20）
    ];
    const queries = [
      { query: '展示会 ブース', clicks: '67', impressions: '3420', ctr: '1.96', position: '6.8' },
    ];

    it('selects pages in positions 5-20 sorted by impressions desc', () => {
      const selected = selectTestPages(pages, queries, '展示会,ブース,イベント');
      assert.equal(selected.length, 4); // page5 and page6 excluded (pos 4.2 and 25.0)
      assert.equal(selected[0].url, 'https://orgiast.jp/event/booth-cost'); // 3420 impressions (highest)
      assert.equal(selected[1].url, 'https://orgiast.jp/event/booth-construction'); // 2340 impressions
      assert.equal(selected[2].url, 'https://orgiast.jp/event/exhibition'); // 1890 impressions
      assert.equal(selected[3].url, 'https://orgiast.jp/event/promotion'); // 890 impressions
    });

    it('limits to maxPages', () => {
      const selected = selectTestPages(pages, queries, '展示会,ブース,イベント', 2);
      assert.equal(selected.length, 2);
    });

    it('returns empty when no keywords match', () => {
      const selected = selectTestPages(pages, queries, 'nonexistent');
      assert.equal(selected.length, 0);
    });
  });

  describe('compareSnapshots', () => {
    it('compares before and after snapshots', () => {
      const before = makeMockPages();
      const after = makeMockAfterPages();
      const comparisons = compareSnapshots(before, after);
      assert.equal(comparisons.length, 5);
      const first = comparisons[0];
      assert.equal(first.status, 'measured');
      assert.equal(first.diff.clicks, 13); // 58 - 45
      assert.equal(first.diff.impressions, 170); // 2510 - 2340
      assert.ok(first.pctClicks > 0);
    });

    it('marks new pages without before data', () => {
      const before = makeMockPages();
      const after = { ...makeMockAfterPages(), pages: [
        ...makeMockAfterPages().pages,
        { url: '/new-page', clicks: 5, impressions: 100, ctr: 5.0, position: 10.0 },
      ]};
      const comparisons = compareSnapshots(before, after);
      const newPage = comparisons.find(c => c.url === '/new-page');
      assert.equal(newPage.status, 'new');
    });
  });

  describe('generatePlanReport', () => {
    const pagesCsv = makeMockPages().pages.map(p => ({
      url: p.url, clicks: String(p.clicks), impressions: String(p.impressions),
      ctr: String(p.ctr), position: String(p.position),
    }));
    const queriesCsv = [
      { query: '展示会', clicks: '10', impressions: '100', ctr: '10.0', position: '8.0' },
    ];

    it('generates markdown plan report', () => {
      const selected = selectTestPages(pagesCsv, queriesCsv, '展示会,ブース,イベント');
      const report = generatePlanReport(selected, '展示会,ブース,イベント');
      assert.ok(report.includes('# SEO少数ページテスト計画'));
      assert.ok(report.includes(pagesCsv[0].url));
      assert.ok(report.includes('⚠️')); // backlink warning
    });

    it('respects no-backlink-warning flag', () => {
      const selected = selectTestPages(pagesCsv, queriesCsv, '展示会,ブース,イベント');
      const report = generatePlanReport(selected, '展示会,ブース,イベント', { backlinkWarning: false });
      assert.ok(!report.includes('⚠️'));
    });
  });

  describe('generateComparisonReport', () => {
    it('generates markdown comparison report', () => {
      const before = makeMockPages();
      const after = makeMockAfterPages();
      const comparisons = compareSnapshots(before, after);
      const report = generateComparisonReport(comparisons);
      assert.ok(report.includes('# SEOスキル導入 前後比較レポート'));
      assert.ok(report.includes('サマリ'));
      assert.ok(report.includes('クリック増加'));
    });
  });

  describe('generateAiCitationReport', () => {
    it('generates markdown citation report', () => {
      const items = generateAiCitationTracker('orgiast.jp', ['展示会 ブース 費用', '小規模ブース']);
      const report = generateAiCitationReport(items);
      assert.ok(report.includes('# AI回答引用 追跡レポート'));
      assert.ok(report.includes('展示会 ブース 費用'));
    });
  });

  describe('generateAiCitationTracker', () => {
    it('creates tracker items for queries', () => {
      const items = generateAiCitationTracker('orgiast.jp', ['query1', 'query2']);
      assert.equal(items.length, 2);
      assert.equal(items[0].status, '未確認');
      assert.equal(items[0].domain, 'orgiast.jp');
    });
  });

  describe('CLI modes', () => {
    it('mock-plan produces output', async () => {
      // Just test the function directly rather than CLI
      const before = makeMockPages();
      const jsonPages = before.pages.map(p => ({
        url: p.url, clicks: String(p.clicks), impressions: String(p.impressions),
        ctr: String(p.ctr), position: String(p.position),
      }));
      const mockQueriesRaw = [
        { query: '展示会 ブース 費用', clicks: '67', impressions: '3420', ctr: '1.96', position: '6.8' },
        { query: '小規模ブース デザイン', clicks: '32', impressions: '1890', ctr: '1.69', position: '12.3' },
      ];
      // URLs from makeMockPages() contain 'booth' and 'event' which match 'ブース' and 'イベント'
      const selected = selectTestPages(jsonPages, mockQueriesRaw, 'ブース,イベント');
      assert.ok(selected.length > 0);
    });
  });
});