#!/usr/bin/env node
/**
 * tools/gsc-preflight.test.mjs
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  normalizeUrl,
  isBotQuery,
  classifyBotQuery,
  matchesMainQuery,
  evaluateQuery,
  prepareRows,
  runPreflight,
  parseCsvGsc,
} from './gsc-preflight.mjs';

describe('normalizeUrl', () => {
  it('# と ? と末尾 / を除去し https・www を統一する', () => {
    assert.equal(
      normalizeUrl('http://www.Example.com/topics/6610#SDGs7?utm=1/'),
      'https://example.com/topics/6610',
    );
    assert.equal(normalizeUrl('https://rebooth.co.jp/exhibition/1336/'), 'https://rebooth.co.jp/exhibition/1336');
    assert.equal(normalizeUrl('https://www.orgiast.jp/'), 'https://orgiast.jp');
  });
});

describe('isBotQuery / classifyBotQuery', () => {
  it('site: / url: / scraper / bot / ハッシュ風を除外する', () => {
    assert.equal(isBotQuery('site:orgiast.jp ブース'), true);
    assert.equal(classifyBotQuery('site:orgiast.jp').reason, 'site:');
    assert.equal(isBotQuery('url:https://example.com'), true);
    assert.equal(isBotQuery('booth scraper dump'), true);
    assert.equal(isBotQuery('seo bot crawl'), true);
    assert.equal(isBotQuery('a1b2c3d4e5f6g7h8'), true);
    assert.equal(classifyBotQuery('a1b2c3d4e5f6g7h8').reason, 'alnum-run');
    assert.equal(isBotQuery('550e8400-e29b-41d4-a716-446655440000'), true);
  });

  it('通常の日本語・英語クエリは残す', () => {
    assert.equal(isBotQuery('展示会ブース 制作'), false);
    assert.equal(isBotQuery('exhibition booth design'), false);
  });
});

describe('matchesMainQuery（語単位の全包含）', () => {
  it('空白違いでも主クエリの語がすべて含まれれば一致する', () => {
    assert.equal(matchesMainQuery('展示会 ブース 費用', '展示会ブース 費用'), true);
    assert.equal(matchesMainQuery('展示会 ブース 施工 費用', '展示会ブース 費用'), true);
    assert.equal(matchesMainQuery('展示会\u3000ブース\u3000費用', '展示会ブース 費用'), true);
    assert.equal(matchesMainQuery('ブースデザイン基本', 'ブース デザイン'), true);
  });

  it('語が欠けていれば不一致', () => {
    assert.equal(matchesMainQuery('展示会 ブース', '展示会ブース 費用'), false);
    assert.equal(matchesMainQuery('ブース 施工', '展示会ブース 費用'), false);
  });
});

describe('prepareRows', () => {
  it('正規化で #付きURLを統合し除外数を数える', () => {
    const rows = [
      { query: '展示会ブース 制作', page: 'https://www.rebooth.co.jp/a/#x', clicks: 1, impressions: 10, position: 5 },
      { query: '展示会ブース 制作', page: 'https://rebooth.co.jp/a/?utm=1', clicks: 2, impressions: 20, position: 8 },
      { query: 'site:rebooth.co.jp', page: 'https://rebooth.co.jp/a/', clicks: 0, impressions: 5, position: 1 },
    ];
    const prepared = prepareRows(rows);
    assert.equal(prepared.excludedCount, 1);
    assert.equal(prepared.keptCount, 2);
    assert.equal(prepared.mergedCount, 1);
    assert.equal(prepared.mergedRows[0].page, 'https://rebooth.co.jp/a');
    assert.equal(prepared.mergedRows[0].clicks, 3);
    assert.equal(prepared.mergedRows[0].impressions, 30);
    assert.equal(prepared.mergedRows[0].position, (5 * 10 + 8 * 20) / 30);
  });
});

describe('evaluateQuery verdict', () => {
  it('下限以上かつ1〜30位なら REWRITE、内部リンクは実URLのみ', () => {
    const rows = [
      { query: '展示会ブース 制作 会社', page: 'https://rebooth.co.jp/exhibition/1336', clicks: 4, impressions: 40, position: 12.5 },
      { query: '展示会ブース 制作', page: 'https://rebooth.co.jp/contact/', clicks: 1, impressions: 25, position: 18 },
      { query: '展示会ブース 制作 流れ', page: 'https://orgiast.jp/topics/999', clicks: 0, impressions: 8, position: 40 },
      { query: '別クエリ', page: 'https://example.com/guessed', clicks: 100, impressions: 1000, position: 1 },
    ];
    const prepared = prepareRows(rows);
    const result = evaluateQuery(prepared.mergedRows, '展示会ブース 制作');
    assert.equal(result.verdict, 'REWRITE');
    assert.equal(result.bestPage, 'https://rebooth.co.jp/exhibition/1336');
    assert.equal(result.position, 12.5);
    assert.equal(result.clicks, 4);
    assert.equal(result.impressions, 40);
    assert.ok(result.internalLinkCandidates.every((c) => typeof c.page === 'string' && c.page.startsWith('https://')));
    assert.ok(!result.internalLinkCandidates.some((c) => c.page.includes('example.com/guessed')));
    assert.ok(!result.internalLinkCandidates.some((c) => c.page === result.bestPage));
    assert.ok(result.internalLinkCandidates.some((c) => c.page === 'https://rebooth.co.jp/contact'));
    // 表示8は下限10未満なので内部リンク候補に含めない
    assert.ok(!result.internalLinkCandidates.some((c) => c.page === 'https://orgiast.jp/topics/999'));
  });

  it('語単位一致（空白違い）でも REWRITE になる', () => {
    const rows = [
      { query: '展示会 ブース 施工 費用', page: 'https://rebooth.co.jp/exhibition/1336', clicks: 2, impressions: 20, position: 8 },
    ];
    const prepared = prepareRows(rows);
    const result = evaluateQuery(prepared.mergedRows, '展示会ブース 費用');
    assert.equal(result.verdict, 'REWRITE');
    assert.equal(result.bestPage, 'https://rebooth.co.jp/exhibition/1336');
    assert.equal(result.matchedRows, 1);
  });

  it('下限未満のページしか無い場合は INSUFFICIENT', () => {
    const rows = [
      { query: '展示会 ブース 費用', page: 'https://rebooth.co.jp/', clicks: 0, impressions: 3, position: 5 },
      { query: '展示会ブース費用相場', page: 'https://orgiast.jp/topics/1', clicks: 0, impressions: 9, position: 12 },
    ];
    const prepared = prepareRows(rows);
    const result = evaluateQuery(prepared.mergedRows, '展示会ブース 費用', { minImpressions: 10 });
    assert.equal(result.verdict, 'INSUFFICIENT');
    assert.equal(result.label, '根拠不足');
    assert.equal(result.bestPage, null);
    assert.equal(result.matchedRows, 2);
    assert.deepEqual(result.internalLinkCandidates, []);
  });

  it('31位以下のみ（下限以上）なら NEW_OK', () => {
    const rows = [
      { query: 'レンタルブース 安い', page: 'https://rebooth.co.jp/', clicks: 0, impressions: 15, position: 55 },
    ];
    const prepared = prepareRows(rows);
    const result = evaluateQuery(prepared.mergedRows, 'レンタルブース');
    assert.equal(result.verdict, 'NEW_OK');
    assert.equal(result.bestPage, 'https://rebooth.co.jp');
    assert.equal(result.position, 55);
  });

  it('一致行が無ければ NEW_OK', () => {
    const prepared = prepareRows([
      { query: '全く別', page: 'https://rebooth.co.jp/', clicks: 1, impressions: 1, position: 1 },
    ]);
    const result = evaluateQuery(prepared.mergedRows, '再利用 ブース');
    assert.equal(result.verdict, 'NEW_OK');
    assert.equal(result.bestPage, null);
    assert.equal(result.matchedRows, 0);
    assert.deepEqual(result.internalLinkCandidates, []);
  });
});

describe('runPreflight / CSV', () => {
  it('母数合計が一致し CSV も読める', () => {
    const csv = [
      'Query,Page,Clicks,Impressions,Position',
      'ブース デザイン,https://www.orgiast.jp/topics/1#a,1,10,2',
      'ブース デザイン,https://orgiast.jp/topics/1/?x=1,2,20,4',
      'site:orgiast.jp,https://orgiast.jp/topics/1,0,1,1',
      'ブース デザイン 基本,https://rebooth.co.jp/x/,0,5,40',
    ].join('\n');
    const rows = parseCsvGsc(csv);
    const report = runPreflight(rows, ['ブース デザイン']);
    const s = report.stats;
    assert.equal(s.inputRows, 4);
    assert.equal(s.excludedRows + s.keptRows + s.droppedEmptyPage, s.inputRows);
    assert.equal(report.results[0].verdict, 'REWRITE');
    assert.equal(report.results[0].bestPage, 'https://orgiast.jp/topics/1');
  });
});
