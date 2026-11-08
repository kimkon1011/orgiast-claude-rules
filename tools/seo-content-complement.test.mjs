import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// モジュールを動的インポート
let mod;
async function loadMod() {
  if (!mod) {
    const modPath = path.join(__dirname, 'seo-content-complement.mjs');
    const modUrl = 'file:///' + modPath.replace(/\\/g, '/');
    mod = await import(modUrl);
  }
  return mod;
}

describe('seo-content-complement', () => {
  // テスト用のキーワードCSVデータ
  const sampleKeywordsCsv = `priority,keyword,intent,category,volume,difficulty,business_value,score,recommended_action
1,展示会ブース 制作,Commercial,ブース制作,300,30,5,50.0,optimize_title
2,展示会 ブース デザイン,Commercial,デザイン,200,25,4,32.0,optimize_title
3,イベント ブース レンタル,Transactional,レンタル,150,20,5,37.5,new_page
4,展示会 装飾 会社,Commercial,装飾,120,35,3,10.3,add_content
5,ブース 施工 費用,Informational,費用,250,40,4,25.0,new_page
6,展示会 小間 レイアウト,Informational,レイアウト,80,15,3,16.0,add_content
7,展示会 看板 デザイン,Commercial,看板,90,20,2,9.0,optimize_title
8,ブース 照明 レンタル,Transactional,照明,60,10,3,18.0,new_page
9,展示会 備品 レンタル,Transactional,備品,70,15,2,9.3,new_page
10,ブース 内装 会社,Commercial,内装,55,25,3,6.6,add_content`;

  // テスト用のGSC CSVデータ
  const sampleGscCsv = `query,impressions,clicks,position,page
展示会ブース レンタル 料金,1200,45,12,https://orgiast.jp/rental
展示会 ブース 大きさ 規定,800,12,18,https://orgiast.jp/booth-spec
イベント ブース 装飾 費用,600,8,25,https://orgiast.jp/decorating
展示会 小間 サイズ 規格,400,15,8,https://orgiast.jp/booth-size
ブース 施工 期間,350,3,22,https://orgiast.jp/construction
展示会 備品 リスト,300,10,15,https://orgiast.jp/equipment
展示会 ブース 予算 相場,280,5,28,https://orgiast.jp/budget
ブース デザイン 依頼 流れ,200,2,30,https://orgiast.jp/design-flow`;

  it('should parse CSV correctly', async () => {
    const m = await loadMod();
    const result = m.parseCsv(sampleKeywordsCsv);
    assert.equal(result.length, 10);
    assert.equal(result[0].keyword, '展示会ブース 制作');
    assert.equal(result[0].priority, '1');
    assert.equal(result[0].recommended_action, 'optimize_title');
  });

  it('should analyze GSC data', async () => {
    const m = await loadMod();
    const gscRows = m.parseCsv(sampleGscCsv);
    const result = m.analyzeGscData(gscRows);
    assert.equal(result.queriesWithImpressions.length, 8);
    assert.ok(result.queriesWithImpressions[0].impressions >= result.queriesWithImpressions[1].impressions);
    // 10-30位のクエリ（position >= 10 && <= 30）
    assert.equal(result.queriesRanked10to30.length, 7);
    // position=8 は10未満なので含まれない
    assert.ok(!result.queriesRanked10to30.some(q => q.position < 10));
    // position=30 は含まれる
    assert.ok(result.queriesRanked10to30.some(q => q.position === 30));
  });

  it('should analyze content structure', async () => {
    const m = await loadMod();

    // 短いコンテンツ
    const shortContent = 'これは短いです。';
    const shortResult = m.analyzeContentStructure(shortContent);
    assert.ok(shortResult.some(s => s.type === 'intro_rewrite'));

    // H2が少ない
    const noH2Content = 'これはH2のないコンテンツです。\n\n段落だけあります。';
    const noH2Result = m.analyzeContentStructure(noH2Content);
    assert.ok(noH2Result.some(s => s.type === 'new_h2'));

    // FAQがある
    const faqContent = '## よくある質問\nQ. これはテストですか？\nA. はい。';
    const faqResult = m.analyzeContentStructure(faqContent);
    assert.ok(!faqResult.some(s => s.type === 'faq_section'));

    // 十分なコンテンツ
    const longContent = 'A'.repeat(150) + '\n\n## H2-1\n内容\n\n## H2-2\n内容\n\n## H2-3\n内容\n\nFAQセクションあり';
    const longResult = m.analyzeContentStructure(longContent);
    assert.ok(!longResult.some(s => s.type === 'intro_rewrite'));
    assert.ok(longResult.length < 3);
  });

  it('should recommend complement types based on intent', async () => {
    const m = await loadMod();

    // Transactional → intro_rewrite
    const txKw = { intent: 'Transactional' };
    const txResult = m.recommendComplementType(txKw, 'コンテンツサンプルです。\n\n## H2\n内容', null);
    assert.ok(txResult.includes('intro_rewrite'));

    // Informational → faq_section, new_h2
    const infoKw = { intent: 'Informational' };
    const infoResult = m.recommendComplementType(infoKw, 'コンテンツサンプルです。\n\n## H2\n内容', null);
    assert.ok(infoResult.includes('faq_section'));
    assert.ok(infoResult.includes('new_h2'));

    // GSC query with impressions → inline_paragraph
    const gscMatch = { impressions: 500, clicks: 10, position: 15, page: 'https://example.com' };
    const gscResult = m.recommendComplementType(infoKw, 'コンテンツ', gscMatch);
    assert.ok(gscResult.includes('inline_paragraph'));

    // new_page action → new_page
    const gapKw = { intent: 'Informational', recommended_action: 'new_page' };
    const gapResult = m.recommendComplementType(gapKw, null, null);
    assert.equal(gapResult.length, 1);
    assert.equal(gapResult[0], 'new_page');
  });

  it('should generate internal link candidates', async () => {
    const m = await loadMod();
    const keywords = [
      { keyword: 'KW1', category: 'CatA' },
      { keyword: 'KW2', category: 'CatA' },
      { keyword: 'KW3', category: 'CatB' },
    ];
    const result = m.generateInternalLinkCandidates(keywords, []);
    // KW1→KW2 と KW2→KW1 の2候補（CatA内）
    assert.ok(result.length >= 1);
    assert.ok(result.some(l => l.sourceKeyword === 'KW1' && l.targetKeyword === 'KW2'));
  });

  it('should handle empty CSV gracefully', async () => {
    const m = await loadMod();
    assert.equal(m.parseCsv('').length, 0);
    assert.equal(m.parseCsv('header1,header2\n').length, 0);
  });
});
