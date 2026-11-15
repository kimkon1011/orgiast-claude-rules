#!/usr/bin/env node
/**
 * SEOコンテンツ補完ツール（X-0013）
 *
 * 既存ランキングページのAI補完SEO:
 * 1. キーワードリサーチ結果（booth-kw-research の出力）を読み込む
 * 2. オプションで GSC CSV を読み込み表示回数があるが記事にないクエリを特定
 * 3. 各キーワードギャップに対して具体的な補完提案（冒頭書換・新H2・FAQ・一文追加）を生成
 * 4. ページ間の内部リンク提案を含む実行計画を出力
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseCsv(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"' && quoted && text[i + 1] === '"') { field += '"'; i += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { row.push(field); field = ''; }
    else if ((char === '\n' || char === '\r') && !quoted) {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); if (row.some(v => v !== '')) rows.push(row); row = []; field = '';
    } else field += char;
  }
  row.push(field); if (row.some(v => v !== '')) rows.push(row);
  if (rows.length < 2) return [];
  const header = rows[0];
  return rows.slice(1).map(values => Object.fromEntries(header.map((name, index) => [name, values[index] ?? ''])));
}

/**
 * GSC CSV から「表示があるが記事にないクエリ」と「10-30位のクエリ」を抽出
 */
function analyzeGscData(gscRows) {
  const queriesWithImpressions = [];
  const queriesRanked10to30 = [];

  for (const row of gscRows) {
    const impressions = Number(row.impressions || row.表示回数 || row.Impressions || 0);
    const clicks = Number(row.clicks || row.クリック数 || row.Clicks || 0);
    const position = Number(row.position || row.掲載順位 || row.Position || 100);
    const query = row.query || row.クエリ || row.Query || '';
    const page = row.page || row.ページ || row.Page || '';

    if (impressions > 0) {
      queriesWithImpressions.push({ query, impressions, clicks, position, page });
    }
    if (position >= 10 && position <= 30 && impressions > 0) {
      queriesRanked10to30.push({ query, impressions, clicks, position, page });
    }
  }

  queriesWithImpressions.sort((a, b) => b.impressions - a.impressions);
  queriesRanked10to30.sort((a, b) => b.impressions - a.impressions);

  return { queriesWithImpressions, queriesRanked10to30 };
}

/**
 * ページの既存コンテンツ構造から補完すべき場所を推定
 */
function analyzeContentStructure(pageContent) {
  const suggestions = [];
  const content = pageContent || '';

  // H2 見出しの数をカウント
  const h2Count = (content.match(/##\s/g) || []).length;

  // FAQ セクションの有無
  const hasFaq = /FAQ|よくある質問|Q\.|Q：/i.test(content);

  // 冒頭パラグラフの長さ
  const firstParaMatch = content.match(/^[^#\n]+/m);
  const firstParaLength = firstParaMatch ? firstParaMatch[0].length : 0;

  if (firstParaLength < 100) {
    suggestions.push({ type: 'intro_rewrite', reason: '冒頭段落が短い（' + firstParaLength + '文字）', priority: 'high' });
  }
  if (h2Count < 3) {
    suggestions.push({ type: 'new_h2', reason: 'H2見出しが少ない（' + h2Count + '個）', priority: 'medium' });
  }
  if (!hasFaq) {
    suggestions.push({ type: 'faq_section', reason: 'FAQセクションがない', priority: 'medium' });
  }

  return suggestions;
}

/**
 * 補完提案タイプをキーワード意図とページ構造から決定
 */
function recommendComplementType(keyword, pageContent, gscQuery) {
  const intent = (keyword.intent || '').toLowerCase();
  const isGap = keyword.recommended_action === 'new_page' || keyword.recommended_action === 'add_content';

  const types = [];

  // 新規ページが必要なキーワード
  if (isGap || !pageContent) {
    types.push('new_page');
    return types;
  }

  // トランザクション系キーワード → 冒頭書き換え＋CTA強化
  if (intent.includes('transactional') || intent.includes('commercial')) {
    types.push('intro_rewrite');
  }

  // 情報系キーワード → FAQセクションか新H2
  if (intent.includes('informational')) {
    types.push('faq_section');
    types.push('new_h2');
  }

  // ナビゲーション系 → 内部リンク強化
  if (intent.includes('navigational')) {
    types.push('internal_link');
  }

  // 表示回数があるがコンテンツがないクエリ → 一文追加
  if (gscQuery && gscQuery.impressions > 0) {
    types.push('inline_paragraph');
  }

  // デフォルト: バランス型
  if (types.length === 0) {
    types.push('intro_rewrite');
    types.push('new_h2');
  }

  return [...new Set(types)];
}

/**
 * 内部リンク候補を生成（同一カテゴリのページ間）
 */
function generateInternalLinkCandidates(keywords, pages) {
  const candidates = [];
  const topKeywords = keywords.slice(0, 10);

  for (const kw of topKeywords) {
    const related = keywords.filter(k =>
      k.category === kw.category && k.keyword !== kw.keyword
    );
    for (const r of related) {
      candidates.push({
        sourceKeyword: kw.keyword,
        targetKeyword: r.keyword,
        category: kw.category || '未分類',
        reason: `${kw.keyword} → ${r.keyword}（${kw.category}カテゴリ）`
      });
    }
  }

  return candidates.slice(0, 10);
}

/**
 * メイン処理
 */
async function main() {
  const args = process.argv.slice(2);

  // オプション
  const keywordsCsvIndex = args.indexOf('--keywords-csv');
  const gscCsvIndex = args.indexOf('--gsc-csv');
  const outputIndex = args.indexOf('--output');
  const pagesJsonIndex = args.indexOf('--pages-json');

  const keywordsCsvPath = keywordsCsvIndex >= 0 ? args[keywordsCsvIndex + 1] : null;
  const gscCsvPath = gscCsvIndex >= 0 ? args[gscCsvIndex + 1] : null;
  const outputDir = outputIndex >= 0 ? args[outputIndex + 1] : 'outputs/X-0013';
  const pagesJsonPath = pagesJsonIndex >= 0 ? args[pagesJsonIndex + 1] : null;

  // デフォルトのキーワードCSVパス（booth-kw-research の出力）
  const defaultKeywordsPath = path.resolve(__dirname, '..', 'skills', 'booth-kw-research', 'output', 'keywords-priority.csv');
  const resolvedKeywordsPath = keywordsCsvPath ? path.resolve(keywordsCsvPath) : defaultKeywordsPath;

  // キーワードCSVを読み込み
  if (!fs.existsSync(resolvedKeywordsPath)) {
    console.error('キーワードCSVが見つかりません:', resolvedKeywordsPath);
    console.error('--keywords-csv でパスを指定するか、先に booth-kw-research を実行してください。');
    process.exit(1);
  }
  const csvText = fs.readFileSync(resolvedKeywordsPath, 'utf-8');
  const keywords = parseCsv(csvText);

  if (keywords.length === 0) {
    console.error('キーワードCSVにデータがありません。');
    process.exit(1);
  }

  // GSC CSV を読み込み（オプション）
  let gscData = null;
  if (gscCsvPath) {
    const resolvedGscPath = path.resolve(gscCsvPath);
    if (!fs.existsSync(resolvedGscPath)) {
      console.error('GSC CSVが見つかりません:', resolvedGscPath);
      process.exit(1);
    }
    const gscCsvText = fs.readFileSync(resolvedGscPath, 'utf-8');
    const gscRows = parseCsv(gscCsvText);
    gscData = analyzeGscData(gscRows);
    console.error('GSCデータ分析完了: 表示ありクエリ %d件, 10-30位クエリ %d件',
      gscData.queriesWithImpressions.length, gscData.queriesRanked10to30.length);
  }

  // ページコンテンツJSONを読み込み（オプション）
  let pages = [];
  if (pagesJsonPath) {
    const resolvedPagesPath = path.resolve(pagesJsonPath);
    if (fs.existsSync(resolvedPagesPath)) {
      pages = JSON.parse(fs.readFileSync(resolvedPagesPath, 'utf-8'));
    }
  }

  // 補完提案を生成
  const complements = [];
  for (const keyword of keywords.slice(0, 20)) {
    // 関連するGSCクエリを検索
    const gscMatch = gscData
      ? gscData.queriesWithImpressions.find(q => q.query.includes(keyword.keyword))
      : null;

    // ページコンテンツ
    const page = pages.find(p =>
      (p.title || '').includes(keyword.keyword) || (p.h1 || '').includes(keyword.keyword)
    );
    const pageContent = page ? (page.content || page.description || '') : '';

    // コンテンツ構造分析
    const structureHints = analyzeContentStructure(pageContent);

    // 補完タイプ決定
    const types = recommendComplementType(keyword, pageContent, gscMatch);

    const complement = {
      keyword: keyword.keyword,
      intent: keyword.intent || '不明',
      priority: keyword.priority,
      score: keyword.score,
      recommended_action: keyword.recommended_action || 'review',
      complement_types: types,
      structure_hints: structureHints,
      gsc_data: gscMatch ? {
        impressions: gscMatch.impressions,
        clicks: gscMatch.clicks,
        position: gscMatch.position,
        page: gscMatch.page
      } : null,
      target_page: page ? { title: page.title, url: page.url } : null
    };

    complements.push(complement);
  }

  // 内部リンク候補
  const internalLinks = generateInternalLinkCandidates(keywords, pages);

  // GSC 10-30位クエリの補完提案
  const gscGaps = gscData ? gscData.queriesRanked10to30.slice(0, 15).map(q => {
    // 既存キーワードに含まれているか
    const existingKeyword = keywords.find(k => q.query.includes(k.keyword) || k.keyword.includes(q.query));
    return {
      query: q.query,
      impressions: q.impressions,
      clicks: q.clicks,
      position: q.position,
      page: q.page,
      already_in_keywords: !!existingKeyword,
      matched_keyword: existingKeyword ? existingKeyword.keyword : null,
      complement_types: existingKeyword ? ['content_expansion'] : ['new_content']
    };
  }) : [];

  // 出力を生成
  const output = {
    generated_at: new Date().toISOString(),
    source: {
      keywords_csv: resolvedKeywordsPath,
      gsc_csv: gscCsvPath || null,
      pages_json: pagesJsonPath || null
    },
    summary: {
      total_keywords: keywords.length,
      top_20_complements: complements.length,
      gsc_queries_with_impressions: gscData ? gscData.queriesWithImpressions.length : 0,
      gsc_queries_ranked_10_30: gscData ? gscData.queriesRanked10to30.length : 0,
      internal_link_candidates: internalLinks.length
    },
    complements,
    gsc_gaps: gscGaps,
    internal_links: internalLinks
  };

  // JSON出力
  const jsonPath = path.resolve(outputDir, 'seo-complement-plan.json');
  fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
  fs.writeFileSync(jsonPath, JSON.stringify(output, null, 2));

  // Markdown レポート出力
  const mdLines = [
    '# SEOコンテンツ補完計画（X-0013）',
    '',
    `生成日: ${new Date().toISOString().split('T')[0]}`,
    '',
    '## サマリ',
    '',
    `| 項目 | 値 |`,
    `|---|---|`,
    `| 分析キーワード数 | ${keywords.length} |`,
    `| 補完提案（TOP20） | ${complements.length}件 |`,
    `| GSC表示ありクエリ | ${gscData ? gscData.queriesWithImpressions.length : 'GSCデータなし'} |`,
    `| GSC 10-30位クエリ | ${gscData ? gscData.queriesRanked10to30.length : 'GSCデータなし'} |`,
    `| 内部リンク候補 | ${internalLinks.length}件 |`,
    '',
    '---',
    '',
    '## 補完提案（優先度順）',
    '',
  ];

  for (const c of complements) {
    const typesStr = c.complement_types.join(' / ');
    const structureStr = c.structure_hints.map(h => `- ${h.type}: ${h.reason}`).join('\n');
    mdLines.push(`### ${c.priority}. ${c.keyword}`);
    mdLines.push(`- **意図**: ${c.intent}`);
    mdLines.push(`- **スコア**: ${c.score}`);
    mdLines.push(`- **推奨アクション**: ${c.recommended_action}`);
    mdLines.push(`- **補完タイプ**: ${typesStr}`);
    if (c.target_page) {
      mdLines.push(`- **対象ページ**: [${c.target_page.title}](${c.target_page.url})`);
    }
    if (c.gsc_data) {
      mdLines.push(`- **GSCデータ**: 表示回数 ${c.gsc_data.impressions} / クリック ${c.gsc_data.clicks} / 順位 ${c.gsc_data.position}`);
    }
    if (structureStr) {
      mdLines.push(`- **構造ヒント**:`);
      mdLines.push(structureStr);
    }
    mdLines.push('');
  }

  mdLines.push('---', '', '## GSC 10-30位クエリ（表示回数あり）', '');
  mdLines.push('| クエリ | 表示回数 | クリック | 順位 | キーワード登録済み | 補完タイプ |');
  mdLines.push('|---|---|---|---|---|---|');
  for (const g of gscGaps) {
    mdLines.push(`| ${g.query} | ${g.impressions} | ${g.clicks} | ${g.position} | ${g.already_in_keywords ? '✅' : '❌'} | ${g.complement_types.join(', ')} |`);
  }

  mdLines.push('', '---', '', '## 内部リンク候補', '');
  for (const link of internalLinks) {
    mdLines.push(`- ${link.sourceKeyword} → ${link.targetKeyword}（${link.category}）`);
  }

  mdLines.push('', '---', '', '## 実装手順', '',
    '### 1. WordPress編集', '',
    '1. 各ページのタイトルに主要キーワードを含める（既存の場合は確認）',
    '2. 冒頭2段落で「展示会ブース」に関する核心質問に答える',
    '3. H2見出しを追加（「展示会ブースの種類」「選び方」「費用相場」など）',
    '4. FAQセクションを追加（「展示会ブースの制作期間は？」「予算はいくら必要？」など）',
    '5. 該当ページに表示回数があるが未カバーのクエリを1文追加',
    '6. 独自の施工写真・図面・表を追加（AIに生成させない）',
    '',
    '### 2. 内部リンク', '',
    '1. 同一カテゴリのページ間で相互リンクを設置',
    '2. トップページから主要カテゴリページへの導線を強化',
    '3. 関連事例ページへのリンクを自然な文脈で追加',
    '',
    '### 3. GSC再インデックス', '',
    '1. Google Search Console で編集したURLを「インデックス登録をリクエスト」',
    '2. 7-14日後に効果測定（表示回数・クリック率の変化）',
    '3. 1-3ヶ月サイクルで繰り返し',
    '',
    '---', '',
    '> 本提案はキーワードリサーチ結果とGSCデータに基づく自動生成です。',
    '> 実際の編集前に現状のページ内容を確認し、コンテンツの重複に注意してください。',
  );

  const mdPath = path.resolve(outputDir, 'seo-complement-plan.md');
  fs.writeFileSync(mdPath, mdLines.join('\n'));

  console.log('SEO補完計画を生成しました:');
  console.log('  JSON:', jsonPath);
  console.log('  MD :', mdPath);
  console.log('  補完提案:', complements.length, '件');
  console.log('  内部リンク候補:', internalLinks.length, '件');
  if (gscData) {
    console.log('  GSC 10-30位クエリ:', gscData.queriesRanked10to30.length, '件');
  }
}

// エクスポート（テスト用）
export { parseCsv, analyzeGscData, analyzeContentStructure, recommendComplementType, generateInternalLinkCandidates };

// エントリポイントからの実行時のみ main() を呼ぶ
const entryScript = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
const thisScript = fileURLToPath(import.meta.url).replace(/\\/g, '/');
if (entryScript && entryScript.endsWith(thisScript.split('/').pop())) {
  main().catch(err => { console.error('Error:', err.message); process.exit(1); });
}
