#!/usr/bin/env node
/**
 * 純粋ロジック単体テスト
 *
 * phase2（類似度マージ）・phase3（意図分類フォールバック）・phase4（ページ種別・
 * 内部リンク案・最適化候補）のロジックを関数レベルで検証する。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// phase2: mergeKeywords / charSimilarity
import { charSimilarity, mergeKeywords } from '../process/phase2-collect.mjs';
// phase3: classifyIntentRule
import { classifyIntentRule } from '../process/phase3-score.mjs';
// phase4: buildInternalLinkSuggestions / buildPageOptimizations / pageTypeFor
import { buildInternalLinkSuggestions, buildPageOptimizations, pageTypeFor } from '../process/phase4-propose.mjs';

// dry-run 統合パイプラインは dryrun.test.mjs が担う。ここでは純粋関数を検証する。

describe('phase2 類似度マージ', () => {
  it('charSimilarity: 同一文字列は1', () => {
    assert.equal(charSimilarity('展示会ブース', '展示会ブース'), 1);
  });
  it('charSimilarity: 完全に異なる文字列は低い値', () => {
    const s = charSimilarity('展示会ブース制作', '株主総会の運営');
    assert.ok(s < 0.5, `expected <0.5, got ${s}`);
  });
  it('mergeKeywords: 類似度0.8以上のキーワードはマージされる', () => {
    // 「展示会ブース」と「展示会ブースの」は距離1/長7 = 類似度0.86 → 閾値0.8以上でマージ
    const merged = mergeKeywords([
      { text: '展示会ブース' },
      { text: '展示会ブースの' },
      { text: '株主総会準備' },
    ]);
    const texts = merged.map(m => m.text);
    assert.ok(texts.some(t => t.includes('展示会ブース')), `merged=${texts.join(',')}`);
    assert.ok(texts.some(t => t.includes('株主総会')), `株主総会 should survive`);
    assert.ok(merged.filter(m => m.text.includes('展示会')).length === 1,
      'should merge similar keywords into one group');
  });

  it('mergeKeywords: 類似度0.8未満（展示会ブース vs 展示会ブース制作=0.75）はマージしない', () => {
    const merged = mergeKeywords([
      { text: '展示会ブース' },
      { text: '展示会ブース制作' },
    ], 0.8);
    assert.equal(merged.length, 2, '0.75 < 0.8 なので別キーワードのまま');
  });
});

describe('phase3 意図分類フォールバック', () => {
  it('価格・見積系は Transactional', () => {
    assert.equal(classifyIntentRule('展示会ブース制作 費用相場'), 'Transactional');
  });
  it('比較・評判系は Commercial', () => {
    assert.equal(classifyIntentRule('展示会ブース制作 会社比較 ランキング'), 'Commercial');
  });
  it('とは・意味系は Informational', () => {
    assert.equal(classifyIntentRule('展示会ブース制作とは'), 'Informational');
  });
  it('既定（無特徴）は Commercial', () => {
    assert.equal(classifyIntentRule('展示会ブース制作'), 'Commercial');
  });
});

describe('phase4 提案ロジック', () => {
  const csvRow = (keyword, intent, score, action) =>
    `1,${keyword},${intent},展示会ブース制作,50,30,2000000,${score},${action}`;

  it('pageTypeFor: Transactional はサービスページ', () => {
    assert.equal(pageTypeFor('Transactional', '展示会ブース制作 見積'), 'サービスページ');
  });
  it('pageTypeFor: Commercial は事例', () => {
    assert.equal(pageTypeFor('Commercial', '展示会ブース制作 事例'), '事例');
  });
  it('pageTypeFor: Informational はコラム', () => {
    assert.equal(pageTypeFor('Informational', '展示会ブース制作とは'), 'コラム');
  });

  it('buildInternalLinkSuggestions: 新規記事キーワードがハブとリンク案を生成', () => {
    const keywords = [
      csvRow('展示会ブース制作', 'Commercial', 90, '新規記事作成'),
      csvRow('Reブース 比較', 'Commercial', 80, '新規記事作成'),
      csvRow('SDGs ブース 事例', 'Commercial', 70, '既存ページ改善'),
    ];
    const rows = buildInternalLinkSuggestions(keywords);
    assert.ok(rows.length > 0, 'should produce link suggestions');
    assert.ok(rows[0].includes('ハブ'), 'first row should be hub');
    assert.ok(rows.some(r => r.includes('相互リンク')), 'should include mutual link suggestions');
  });

  it('buildPageOptimizations: 既存タイトルに含まれるキーワードは最適化候補になる', () => {
    const keywords = [csvRow('展示会ブース制作', 'Commercial', 90, '既存ページ改善')];
    const crawlData = [{
      domain: 'https://orgiast.jp',
      pages: [{ title: '展示会ブース制作 | オージャスト' }],
    }];
    const rows = buildPageOptimizations(keywords, crawlData);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].suggestion.includes('展示会ブース制作'));
  });
});