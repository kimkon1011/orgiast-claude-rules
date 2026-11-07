#!/usr/bin/env node
/**
 * Phase 4: コンテンツ提案生成
 *
 * 優先キーワードリストからコンテンツギャップ分析と最適化提案を生成する。
 *
 * 使用法: node process/phase4-propose.mjs
 *
 * TODO(codex): 以下の実装が必要
 * - 優先キーワードと自社サイトのトピックカバレッジ比較
 * - カバレッジ不足キーワードの特定（コンテンツギャップ）
 * - 推奨ページ種別の割り当て（サービスページ/事例/コラム）
 * - 既存ページのタイトル・H1・メタディスクリプション最適化提案
 * - 内部リンク構造改善案の生成（サイロ構造の推奨）
 * - Markdown提案書の出力（content-gaps.md）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function generateProposal(keywords, crawlResults) {
  // 実装予定: コンテンツギャップ分析と提案書生成
  const sections = [];
  // 現状はテンプレート出力
  return sections;
}

async function main() {
  const kwPath = path.join(__dirname, '..', 'output', 'keywords-priority.csv');
  const crawlPath = path.join(__dirname, '..', 'output', 'crawl-results.json');
  const keywords = fs.readFileSync(kwPath, 'utf-8').split('\n').slice(1).filter(Boolean);
  const crawlData = JSON.parse(fs.readFileSync(crawlPath, 'utf-8'));

  const orgiastPages = crawlData
    .filter(s => s.domain === 'https://orgiast.jp')
    .flatMap(s => s.pages);
  const existingTopics = new Set(orgiastPages.map(p => p.title));

  const gaps = keywords.filter(kw => {
    const k = kw.split(',')[1]; // keyword column
    return ![...existingTopics].some(t => t.includes(k));
  });

  const sections = generateProposal(keywords, crawlData);
  const md = [
    '# 展示会ブース制作 コンテンツ最適化提案',
    '',
    `生成日: ${new Date().toISOString().split('T')[0]}`,
    '',
    '## サマリ',
    `- 分析キーワード数: ${keywords.length}`,
    `- コンテンツギャップ: ${gaps.length}キーワード`,
    `- 自社ページ数: ${orgiastPages.length}`,
    '',
    '## 優先キーワード TOP20',
    '',
    '| 順位 | キーワード | 意図 | スコア | 推奨ページ種別 |',
    '|---|---|---|---|---|',
    ...keywords.slice(0, 20).map((kw, i) => {
      const parts = kw.split(',');
      return `| ${i + 1} | ${parts[1] || ''} | ${parts[2] || ''} | ${parts[7] || ''} | コラム |`;
    }),
    '',
    '## コンテンツギャップ（未カバーの需要キーワード）',
    '',
    ...gaps.slice(0, 10).map((kw, i) => {
      const parts = kw.split(',');
      return `${i + 1}. **${parts[1] || ''}** (意図: ${parts[2] || ''}, スコア: ${parts[7] || ''})`;
    }),
    '',
    '## 既存ページ最適化候補',
    '',
    '（TODO: Phase 1のクロール結果と優先キーワードを突き合わせて生成）',
    '',
    '## 内部リンク改善案',
    '',
    '（TODO: サイロ構造の分析と改善提案）',
    '',
    '---',
    '',
    '> 本提案はAIエージェントが自動生成したものです。実装前にSEO担当者のレビューを推奨します。',
  ].join('\n');

  const outPath = path.join(__dirname, '..', 'output', 'content-gaps.md');
  fs.writeFileSync(outPath, md);
  console.log(`Phase 4 complete → ${outPath}`);
}

main().catch(e => {
  console.error('Phase 4 failed:', e.message);
  process.exit(1);
});