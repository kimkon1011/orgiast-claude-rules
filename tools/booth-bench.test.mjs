import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyPrompt, estimateTokens, costPerRoute, qualityScore, loadBenchmarks, runBenchmark, renderReport } from './booth-bench.mjs';

describe('booth-bench', () => {
  describe('classifyPrompt', () => {
    it('classifies simple routes', () => {
      assert.equal(classifyPrompt('展示会タイトルを3案考えて'), 'simple');
    });
    it('classifies medium routes', () => {
      assert.equal(classifyPrompt('ブース企画を200字で要約してください'), 'medium');
    });
    it('classifies complex routes', () => {
      assert.equal(classifyPrompt('10m×10mのブース設計仕様書を作成'), 'complex');
    });
  });

  describe('estimateTokens', () => {
    it('returns positive integer', () => {
      assert.ok(estimateTokens('展示会タイトルを3案') > 0);
    });
  });

  describe('costPerRoute', () => {
    it('returns 0 for unknown route', () => {
      assert.equal(costPerRoute('unknown', 100, 50), 0);
    });
    it('returns positive cost for known route', () => {
      assert.ok(costPerRoute('simple', 100, 30) > 0);
    });
    it('complex route costs more than simple', () => {
      const s = costPerRoute('simple', 100, 30);
      const c = costPerRoute('complex', 100, 300);
      assert.ok(c > s);
    });
  });

  describe('qualityScore', () => {
    it('returns score between 1 and 5', () => {
      for (const route of ['simple', 'medium', 'complex']) {
        for (const expected of ['simple', 'medium', 'complex']) {
          const s = qualityScore(route, expected);
          assert.ok(s >= 1 && s <= 5, `route=${route} expected=${expected} score=${s}`);
        }
      }
    });
    it('expected route scores higher', () => {
      assert.ok(qualityScore('simple', 'simple') > qualityScore('simple', 'complex'));
    });
  });

  describe('loadBenchmarks', () => {
    it('loads and parses all 25 entries', () => {
      const items = loadBenchmarks();
      assert.equal(items.length, 25);
      assert.ok(items.every(i => i.id && i.category && i.prompt && i.expectedRoute));
    });
  });

  describe('runBenchmark', () => {
    it('runs mock benchmark without errors', () => {
      const items = [{ id: 'test1', category: 'title', prompt: '展示会タイトルを3案', expectedRoute: 'simple' }];
      const result = runBenchmark({ mock: true, benchmarks: items });
      assert.equal(result.rows.length, 1);
      assert.equal(result.summary.total, 1);
      assert.ok(result.summary.totalCostUsd >= 0);
      assert.ok(typeof result.summary.avgQuality === 'number');
    });
  });

  describe('renderReport', () => {
    it('produces markdown output', () => {
      const items = [
        { id: 't1', category: 'title', prompt: '展示会タイトルを3案', expectedRoute: 'simple' },
        { id: 't2', category: 'spec', prompt: '10m×10mのブース設計仕様書', expectedRoute: 'complex' },
      ];
      const result = runBenchmark({ mock: true, benchmarks: items });
      const report = renderReport(result);
      assert.ok(report.includes('Booth Design Benchmark Report'));
      assert.ok(report.includes('t1'));
      assert.ok(report.includes('t2'));
      assert.ok(report.includes('✅'));
    });
  });
});
