#!/usr/bin/env node
/**
 * Phase 4: コンテンツ提案生成
 *
 * 優先キーワードリストからコンテンツギャップ分析と最適化提案を生成する。
 *
 * 使用法:
 *   node process/phase4-propose.mjs
 *   node process/phase4-propose.mjs --dry-run <outdir>
 *
 * TODO(codex): 残実装
 * - H1・メタディスクリプション単位の最適化提案（現状はタイトル主体）
 *
 * 実装済み: トピックカバレッジ比較・ギャップ特定・ページ種別割当・タイトル最適化案・内部リンク（サイロ）案・提案書出力
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 推奨ページ種別の割り当て
 * - Transactional / 見積・費用系 → サービスページ
 * - Commercial / 事例・実績系 → 事例
 * - Informational / 知識系・それ以外 → コラム
 */
export function pageTypeFor(intent, keywordText) {
  const t = keywordText || '';
  if (intent === 'Transactional' || /価格|費用|単価|料金|見積|値段/.test(t)) return 'サービスページ';
  if (intent === 'Commercial' || /比較|ランキング|違い|評判|口コミ|事例|選び方|おすすめ/.test(t)) return '事例';
  return 'コラム';
}

function generateProposal(keywords, crawlData) {
  const sections = [];
  for (const kw of keywords) {
    const parts = kw.split(',');
    const keywordText = parts[1] || '';
    const intent = parts[2] || '';
    const score = Number(parts[7] || 0);
    const action = parts[8] || '';
    sections.push({
      keyword: keywordText,
      intent,
      score,
      action,
      pageType: pageTypeFor(intent, keywordText),
      proposal: pageTypeFor(intent, keywordText),
    });
  }
  return sections;
}

/** 既存ページと優先キーワードの突き合わせで最適化候補を生成 */
export function buildPageOptimizations(keywords, crawlData) {
  const rows = [];
  const orgiastPages = crawlData
    .filter(s => s.domain === 'https://orgiast.jp')
    .flatMap(s => s.pages || []);
  const pageTitles = orgiastPages.map(p => p.title || '');
  for (const kw of keywords) {
    const parts = kw.split(',');
    const k = parts[1] || '';
    if (!k) continue;
    const matched = pageTitles.find(t => t.includes(k));
    if (matched) {
      rows.push({
        keyword: k,
        action: parts[8] || '既存ページ改善',
        current_title: matched,
        suggestion: `${matched}（キーワード「${k}」をタイトル前半に含める・意図に合致する導入文に更新）`,
      });
    }
  }
  return rows;
}

/** 優先(新規記事)キーワード同士の想定URLからサイロ構造を提示する内部リンク改善案 */
export function buildInternalLinkSuggestions(keywords) {
  const rows = [];
  const newPages = keywords
    .map(kw => kw.split(','))
    .filter(p => (p[8] || '').includes('新規記事'))
    .slice(0, 10);
  const hub = newPages[0];
  if (hub) {
    const hubKeyword = hub[1] || '';
    rows.push(`- ハブ: 「${hubKeyword}」ページをカテゴリの中心（サイロTOP）にし、下記を内部リンクで束ねる`);
    for (const p of newPages.slice(1)) {
      rows.push(`  - 「${p[1] || ''}」→「${hubKeyword}」への相互リンク（アンカーテキストは対象キーワード）`);
    }
  }
  return rows;
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const dryRunIndex = process.argv.indexOf('--dry-run');
  const outdir = isDryRun && dryRunIndex + 1 < process.argv.length
    ? path.resolve(process.argv[dryRunIndex + 1])
    : null;
  if (isDryRun && !outdir) {
    console.error('Usage: node process/phase4-propose.mjs --dry-run <outdir>');
    process.exit(1);
  }

  const kwPath = isDryRun
    ? path.join(outdir, 'keywords-priority.csv')
    : path.join(__dirname, '..', 'output', 'keywords-priority.csv');
  const crawlPath = isDryRun
    ? path.join(outdir, 'crawl-results.json')
    : path.join(__dirname, '..', 'output', 'crawl-results.json');

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
  const pageOptims = buildPageOptimizations(keywords, crawlData);
  const linkSuggestions = buildInternalLinkSuggestions(keywords);
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
    '| 順位 | キーワード | 意図 | スコア | 推奨アクション | 推奨ページ種別 |',
    '|---|---|---|---|---|---|',
    ...sections.slice(0, 20).map((s, i) => {
      return `| ${i + 1} | ${s.keyword} | ${s.intent} | ${s.score} | ${s.action} | ${s.pageType} |`;
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
    ...(pageOptims.length
      ? pageOptims.slice(0, 10).map(o => `- **${o.keyword}**: ${o.suggestion}`)
      : ['（該当なし: 既存ページと優先キーワードの一致なし）']),
    '',
    '## 内部リンク改善案',
    '',
    ...(linkSuggestions.length ? linkSuggestions : ['（対象なし: 新規記事推奨キーワードが未検出）']),
    '',
    '---',
    '',
    '> 本提案はAIエージェントが自動生成したものです。実装前にSEO担当者のレビューを推奨します。',
  ].join('\n');

  const outPath = isDryRun
    ? path.join(outdir, 'content-gaps.md')
    : path.join(__dirname, '..', 'output', 'content-gaps.md');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, md);
  console.log(`Phase 4 complete → ${outPath}`);
}

// 直接実行時のみ main() を走らせる（テストから import された場合は実行しない）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error('Phase 4 failed:', e.message);
    process.exit(1);
  });
}