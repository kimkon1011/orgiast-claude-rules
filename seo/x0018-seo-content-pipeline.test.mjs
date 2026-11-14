import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mockKeywordResearch, mockContentDraft, formatResearchReport, INDUSTRY_KNOWLEDGE } from './x0018-seo-content-pipeline.mjs';

describe('X-0018 SEO Content Pipeline', () => {
  describe('mockKeywordResearch', () => {
    it('should return analysis object with target keyword', () => {
      const result = mockKeywordResearch('展示会 ブース 制作 費用');
      assert.ok(result.analysis);
      assert.equal(result.analysis.targetKeyword, '展示会 ブース 制作 費用');
    });

    it('should return 3 keyword groups', () => {
      const result = mockKeywordResearch('展示会 ブース 制作');
      assert.equal(result.groups.length, 3);
    });

    it('should return competitor analysis with 3 entries', () => {
      const result = mockKeywordResearch('展示会 ブース 制作 費用');
      assert.equal(result.competitorAnalysis.length, 3);
    });

    it('should return content gaps array', () => {
      const result = mockKeywordResearch('展示会 ブース 制作');
      assert.ok(Array.isArray(result.contentGaps));
      assert.ok(result.contentGaps.length >= 3);
    });

    it('should include industry-specific case study references', () => {
      const result = mockKeywordResearch('展示会 ブース 制作');
      assert.ok(result.competitorAnalysis.some(c => c.url.includes('orgiast.jp') || c.url.includes('rebooth.co.jp')));
    });
  });

  describe('mockContentDraft', () => {
    it('should include [SCREENSHOT] placeholder', () => {
      const draft = mockContentDraft('展示会 初めて ブース 費用', '情報収集');
      assert.ok(draft.includes('[SCREENSHOT:'), 'Must contain SCREENSHOT placeholder');
    });

    it('should include [MY TAKE] placeholder', () => {
      const draft = mockContentDraft('展示会 ブース 制作', '比較検討');
      assert.ok(draft.includes('[MY TAKE:'), 'Must contain MY TAKE placeholder');
    });

    it('should include FAQ section', () => {
      const draft = mockContentDraft('展示会 ブース 制作 費用', '商業調査');
      assert.ok(draft.includes('よくある質問（FAQ）'), 'Must have FAQ section');
      assert.ok(draft.includes('Q1.'), 'Must have at least Q1');
    });

    it('should include frontmatter title', () => {
      const draft = mockContentDraft('展示会 小間 施工', '情報収集');
      assert.ok(draft.includes('title:'), 'Must have frontmatter title');
      assert.ok(draft.includes('description:'), 'Must have meta description');
      assert.ok(draft.includes('keyword:'), 'Must have keyword field');
    });

    it('should include year in title for freshness signal', () => {
      const draft = mockContentDraft('展示会 ブース レンタル', '取引');
      const year = new Date().getFullYear().toString();
      assert.ok(draft.includes(year), `Title should include current year ${year}`);
    });

    it('should include CTA in summary section', () => {
      const draft = mockContentDraft('展示会 ブース デザイン', '情報収集');
      assert.ok(draft.includes('まとめ'), 'Must have summary/final section');
    });

    it('should not contain specific company promotion in main content', () => {
      const draft = mockContentDraft('展示会 ブース 費用', '比較検討');
      assert.ok(!draft.includes('株式会社オージャストに'), 'Main content should not explicitly promote orgiast');
    });
  });

  describe('formatResearchReport', () => {
    it('should format a complete markdown report', () => {
      const data = mockKeywordResearch('展示会 ブース 制作 費用');
      const report = formatResearchReport(data);
      assert.ok(report.includes('# キーワード分析レポート'));
      assert.ok(report.includes('推定キーワード難易度'));
      assert.ok(report.includes('コンテンツギャップ'));
      assert.ok(report.includes('費用相場参考'));
    });

    it('should include low KD patterns table', () => {
      const data = mockKeywordResearch('展示会 ブース 制作');
      const report = formatResearchReport(data);
      assert.ok(report.includes('地域×サービス'));
      assert.ok(report.includes('課題解決型'));
    });
  });

  describe('INDUSTRY_KNOWLEDGE', () => {
    it('should have seed keywords for exhibition niche', () => {
      assert.ok(Array.isArray(INDUSTRY_KNOWLEDGE.seedKeywords));
      assert.ok(INDUSTRY_KNOWLEDGE.seedKeywords.length >= 5);
      assert.ok(INDUSTRY_KNOWLEDGE.seedKeywords.some(k => k.includes('展示会')));
    });

    it('should have price ranges for different booth sizes', () => {
      assert.ok(INDUSTRY_KNOWLEDGE.priceRanges.small);
      assert.ok(INDUSTRY_KNOWLEDGE.priceRanges.medium);
      assert.ok(INDUSTRY_KNOWLEDGE.priceRanges.large);
      assert.ok(INDUSTRY_KNOWLEDGE.priceRanges.rebootFirst);
      assert.ok(INDUSTRY_KNOWLEDGE.priceRanges.rebootRepeat);
    });

    it('should have case study reference sites', () => {
      assert.ok(Array.isArray(INDUSTRY_KNOWLEDGE.caseStudySites));
      assert.ok(INDUSTRY_KNOWLEDGE.caseStudySites.length >= 3);
    });

    it('should have 4 low KD keyword patterns', () => {
      assert.equal(INDUSTRY_KNOWLEDGE.lowKdPatterns.length, 4);
    });
  });
});