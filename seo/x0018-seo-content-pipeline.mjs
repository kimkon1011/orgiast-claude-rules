#!/usr/bin/env node
/**
 * X-0018 AI執筆アシスタントSEOコンテンツ7ステップ パイプライン
 *
 * 機能:
 *   --research   キーワード調査と競合分析レポート生成
 *   --draft      コンテンツ下書き生成（[SCREENSHOT][MY TAKE]プレースホルダ入り）
 *   --full       research + draft を連続実行
 *   --kw         ターゲットキーワード（必須）
 *   --intent     検索意図（デフォルト: 情報収集）
 *   --output     出力ファイルパス
 *   --mock       モックモード（LLM呼び出しなし）
 *
 * 使い方:
 *   node seo/x0018-seo-content-pipeline.mjs --research --kw "展示会 ブース 制作 費用" --output outputs/X-0018/analysis.md
 *   node seo/x0018-seo-content-pipeline.mjs --draft --kw "展示会 ブース 制作 費用" --output outputs/X-0018/draft.md
 *   node seo/x0018-seo-content-pipeline.mjs --full --kw "展示会 初めて ブース 費用" --output outputs/X-0018/full.md
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert/strict';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 展示会ブース制作 業界知識ベース ───
const INDUSTRY_KNOWLEDGE = {
  seedKeywords: [
    '展示会 ブース 制作',
    '展示会 出展 準備',
    'ブース デザイン',
    '展示会 小間 施工',
    'イベント ブース 設営',
  ],
  priceRanges: {
    small: { min: 50, max: 150, unit: '万円', description: '小規模ブース（3小間以下）' },
    medium: { min: 150, max: 500, unit: '万円', description: '中規模ブース（4〜6小間）' },
    large: { min: 500, max: 1500, unit: '万円', description: '大規模ブース（7小間以上）' },
    rebootFirst: { min: 100, max: 300, unit: '万円', description: 'Re:ブース初回' },
    rebootRepeat: { min: 50, max: 150, unit: '万円', description: 'Re:ブース2回目以降' },
  },
  lowKdPatterns: [
    { pattern: '地域×サービス', example: '[地域名] 展示会 ブース 制作 会社', difficulty: '最も低い' },
    { pattern: '業種×サービス', example: '[業種] 展示会 ブース 制作 事例', difficulty: '低い' },
    { pattern: '課題解決型', example: '展示会 初めて ブース 制作 費用', difficulty: '低い' },
    { pattern: '比較・検討', example: '展示会 ブース 制作 会社 ランキング', difficulty: '中程度' },
  ],
  caseStudySites: [
    { name: 'orgiast.jp', url: 'https://www.orgiast.jp/topics/7689', label: 'ブース装飾費用ガイド' },
    { name: 'rebooth.co.jp', url: 'https://rebooth.co.jp/works/964/', label: '脱炭素経営エキスポ事例' },
    { name: 'rebooth.co.jp', url: 'https://rebooth.co.jp/works/1037/', label: 'DX総合EXPO事例' },
  ],
};

// ─── ヘルパー ───

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function resolveOutputPath(filePath) {
  const resolved = resolve(filePath);
  const dir = dirname(resolved);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return resolved;
}

// ─── Mock keyword research ───

function mockKeywordResearch(keyword) {
  const analysis = {
    id: generateId(),
    date: todayDate(),
    targetKeyword: keyword,
    seedGroup: '展示会 ブース 制作',
    searchVolume: '100〜300/月（推定）',
    keywordDifficulty: '12/100（低難易度）',
    searchIntent: '商業調査（Commercial Investigation）',
  };

  const groups = [
    {
      name: '情報収集（Information）',
      keywords: [
        `展示会 ブース 制作 費用 ${keyword.includes('初めて') ? 'の目安' : ''}`,
        `展示会 出展 費用 内訳 ブース ${keyword.includes('費用') ? '制作' : ''}`,
        `展示会 小間 施工 料金 相場`,
        `ブース デザイン 発注 の流れ`,
      ].filter(Boolean),
    },
    {
      name: '比較検討（Commercial）',
      keywords: [
        `展示会 ブース 制作 会社 比較`,
        `展示会 小間 施工 業者 選び方`,
        `リユース 展示会 ブース 評判`,
        `格安 展示会 ブース 制作 口コミ`,
      ],
    },
    {
      name: '取引（Transactional）',
      keywords: [
        `展示会 ブース 制作 見積もり ${['東京', '大阪', '名古屋'][Math.floor(Math.random() * 3)]}`,
        `小間 施工 依頼 できる 会社`,
        `展示会 ブース レンタル 短期`,
      ],
    },
  ];

  const competitorAnalysis = [
    { rank: 1, url: 'https://www.orgiast.jp/topics/7689', type: '記事（自社メディア）', strength: '費用・種類を網羅', gap: '実事例の写真不足' },
    { rank: 2, url: 'https://rebooth.co.jp/works-top/', type: '実績一覧', strength: '豊富な事例', gap: '価格帯のみで詳細な費用内訳なし' },
    { rank: 3, url: 'https://www.orgiast.jp/topics/7659', type: '記事（ノウハウ）', strength: 'スケジュール解説が詳細', gap: '費用との紐付け弱い' },
  ];

  const contentGaps = [
    '初めての出展者が知りたい「総費用のリアルな内訳」を明確にした記事がない',
    '「予算が少ない場合の具体策」に特化したコンテンツが不足',
    '6小間以下の小規模ブースに特化したデザイン事例が少ない',
    '展示会会社の選定基準を比較表で見せているページが少ない',
  ];

  return { analysis, groups, competitorAnalysis, contentGaps };
}

// ─── Mock content draft generation ───

function mockContentDraft(keyword, intent) {
  const kw = keyword || '展示会 ブース 制作';
  const title = `${kw}の完全ガイド【${todayDate().slice(0, 4)}年最新】`;
  const slug = kw.replace(/\s+/g, '-');

  return `---
title: "${title}"
description: "${kw}について、費用相場から発注の流れ、施工会社の選び方まで徹底解説します。初めての出展でも安心のチェックリスト付き。"
keyword: "${kw}"
intent: "${intent || '情報収集・比較検討'}"
category: "展示会ノウハウ"
date: "${todayDate()}"
slug: "${slug}"
---

# ${title}

## はじめに

「${kw}」と検索しているあなたは、展示会への出展を決めたものの、具体的にいくらかかるのか、どこに依頼すればいいのか、何から始めればいいのか分からない状態ではないでしょうか。

この記事では、${kw}について、**費用のリアルな内訳、発注の流れ、施工会社の選び方**を初めての方にも分かりやすく解説します。

[SCREENSHOT: 実際の展示会ブースの仕上がり写真（全景）をここに配置]
*キャプション: 施工例：6小間ブースの全景。奥行きを活かしたレイアウト*

## ${kw}の費用相場

展示会ブースの制作費用は、**規模・デザイン・使用する素材**によって大きく異なります。以下が目安です。

### 小規模ブース（1〜3小間）
- **相場**: 50万〜150万円
- **特徴**: シンプルなパネル＋什器構成。システムパネル使用で低コスト
- **工期**: 設計〜施工まで約2〜3週間

### 中規模ブース（4〜6小間）
- **相場**: 150万〜500万円
- **特徴**: 造作壁・照明演出・映像機器などを組み合わせた本格的なブース
- **工期**: 設計〜施工まで約4〜8週間

### 大規模ブース（7小間以上）
- **相場**: 500万円〜
- **特徴**: 2階建て構造、大型モニター、商談ブース内蔵など
- **工期**: 設計〜施工まで約2〜4ヶ月

[MY TAKE: 編集者コメント：最もコスパが良いのは中規模ブースでRe:ブースを初回利用するケースです。2回目以降は50万円〜と大幅にコストダウンでき、デザインの自由度も高いです。]

## 費用の内訳（詳細）

展示会ブースの制作費用は以下の要素で構成されます。

| 項目 | 割合（目安） | 備考 |
|------|------------|------|
| デザイン・設計費 | 10〜15% | レイアウト図面・3Dパース作成 |
| 制作・施工費 | 50〜60% | パネル加工・塗装・組み立て |
| 運搬・設置費 | 10〜15% | 会場までの配送・現地設営 |
| 照明・電気工事費 | 5〜10% | スポットライト・モニター配線 |
| 備品レンタル費 | 5〜10% | 什器・AV機器・植物装飾 |
| 撤去・廃棄費 | 5〜10% | 展示会終了後の搬出・廃棄 |

[SCREENSHOT: 費用内訳の円グラフ（視覚資料）をここに配置]
*キャプション: 展示会ブース制作費用の内訳（目安）*

## 施工会社の選び方

展示会ブース制作会社を選ぶ際のチェックポイントは以下の5つです。

### 1. 実績・事例の豊富さ
自社の業種やブース規模に近い実績があるかを確認しましょう。

### 2. リユース対応の有無
最近はサステナビリティの観点から、**再利用可能なブース（リユースブース）**を提供する会社が増えています。Re:ブースのようなサービスを選べば、2回目以降のコストを大幅に削減できます。

### 3. 対応範囲の広さ
設計から施工、撤去まで一貫対応している会社の方が、スケジュール管理がスムーズです。

### 4. コミュニケーションの質
展示会の目的・ターゲット・訴求ポイントをヒアリングした上で提案してくれるかを重視しましょう。

### 5. 料金体系の透明性
「基本料金＋オプション」の明確な料金体系かを確認します。見積もりの内訳が不明瞭な会社は避けましょう。

[MY TAKE: 編集者コメント：実際に複数の展示会ブース制作会社に見積もりを取ってみると、同じブースサイズでも価格が2倍以上違うことがあります。最低3社は比較することをおすすめします。]

## 発注の流れ

1. **出展決定（12〜6ヶ月前）**: 展示会の日程・規模を決定
2. **予算設定（10〜6ヶ月前）**: ブース制作予算を策定
3. **制作会社選定（10〜4ヶ月前）**: 3社程度に見積もり依頼
4. **デザイン確定（4〜2ヶ月前）**: ラフ案→3Dパース→素材・色決定
5. **制作・施工（2ヶ月前〜前日）**: パネル制作→現地設営
6. **展示会当日**: 運営・来場者対応
7. **撤去（最終日）**: 搬出・廃棄

## よくある質問（FAQ）

### Q1. ${kw}の予算は最低いくらからですか？
A. 最小規模（1小間、システムパネル、什器最小限）で約50万円から可能です。ただし装飾や備品を追加すると100万円程度になることが一般的です。

### Q2. リユースブースと通常の木工ブース、どちらが安いですか？
A. 初回は通常の木工ブースと同等かやや高い程度ですが、2回目以降は半額以下になります。長期的に出展を続ける予定がある場合は、リユースブースの方が圧倒的にコストメリットがあります。

### Q3. 発注から完成までどのくらい期間が必要ですか？
A. 小規模で2〜3週間、中規模で4〜8週間、大規模で2〜4ヶ月が目安です。急ぎの場合でも最低2週間前までには発注しましょう。

### Q4. 展示会ブースのデザインは自社で決める必要がありますか？
A. ほとんどの制作会社がデザイン提案まで含んだパッケージを提供しています。自社でイメージがあれば伝えれば反映してもらえますが、ゼロからでもプロに任せることが可能です。

### Q5. ブースの撤去費用は別料金ですか？
A. 通常は別料金です。見積もりに撤去費が含まれているか必ず確認しましょう。リユースブースの場合、一部の資材を再利用できるため廃棄費用を抑えられます。

## まとめ

${kw}は、規模や仕様によって50万円から1,500万円以上まで幅広い価格帯があります。初めての出展では、まず以下の3つを決めましょう：

1. **予算の上限**を決める
2. **出展する展示会の規模・期間**を確認する
3. **複数の制作会社から見積もり**を取る

効率的にコストを抑えたい場合は、**リユースブース（Re:ブース）**の検討がおすすめです。

[SCREENSHOT: CTA部分のデザイン案をここに配置]
*キャプション: 問い合わせボタンの設置イメージ*

---

*この記事はAIが下書きを生成し、編集者が加筆修正したハイブリッド形式で制作されています。*`;
}

// ─── CLI ───

function showUsage() {
  console.log(`
X-0018 SEO Content AI Pipeline

Usage:
  node seo/x0018-seo-content-pipeline.mjs --research --kw <keyword> [--output <path>]
  node seo/x0018-seo-content-pipeline.mjs --draft --kw <keyword> [--intent <intent>] [--output <path>]
  node seo/x0018-seo-content-pipeline.mjs --full --kw <keyword> [--output <path>]

Flags:
  --research       Generate keyword research and competitive analysis
  --draft          Generate content draft with [SCREENSHOT][MY TAKE] placeholders
  --full           Run research + draft in sequence
  --kw             Target keyword (required)
  --intent         Search intent description (default: 情報収集)
  --output         Output file path (default: stdout)
  --mock           Mock mode (no LLM calls, default: true for now)
  --help           Show this help

Examples:
  node seo/x0018-seo-content-pipeline.mjs --research --kw "展示会 ブース 制作 費用" --output outputs/X-0018/analysis.md
  node seo/x0018-seo-content-pipeline.mjs --draft --kw "展示会 初めて ブース 費用" --output outputs/X-0018/draft.md
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { mock: true };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--research': opts.research = true; break;
      case '--draft': opts.draft = true; break;
      case '--full': opts.research = true; opts.draft = true; break;
      case '--kw': opts.kw = args[++i]; break;
      case '--intent': opts.intent = args[++i]; break;
      case '--output': opts.output = resolveOutputPath(args[++i]); break;
      case '--mock': opts.mock = true; break;
      case '--help': showUsage(); process.exit(0);
      default: break;
    }
  }

  if (!opts.research && !opts.draft) {
    showUsage();
    process.exit(1);
  }
  if (!opts.kw) {
    console.error('Error: --kw (target keyword) is required');
    process.exit(1);
  }

  return opts;
}

// ─── Report formatters ───

function formatResearchReport({ analysis, groups, competitorAnalysis, contentGaps }) {
  const lines = [];
  lines.push(`# キーワード分析レポート: ${analysis.targetKeyword}`);
  lines.push('');
  lines.push(`- **生成日**: ${analysis.date}`);
  lines.push(`- **シードグループ**: ${analysis.seedGroup}`);
  lines.push(`- **推定検索ボリューム**: ${analysis.searchVolume}`);
  lines.push(`- **推定キーワード難易度**: ${analysis.keywordDifficulty}`);
  lines.push(`- **検索意図**: ${analysis.searchIntent}`);
  lines.push('');

  lines.push('## 関連キーワードグループ');
  lines.push('');
  for (const group of groups) {
    lines.push(`### ${group.name}`);
    for (const kw of group.keywords) {
      lines.push(`- \`${kw}\``);
    }
    lines.push('');
  }

  lines.push('## トップページ分析（推定）');
  lines.push('');
  lines.push('| 順位 | URL | タイプ | 強み | 不足 |');
  lines.push('|------|-----|--------|------|------|');
  for (const c of competitorAnalysis) {
    lines.push(`| ${c.rank} | ${c.url} | ${c.type} | ${c.strength} | ${c.gap} |`);
  }
  lines.push('');

  lines.push('## コンテンツギャップ');
  lines.push('');
  for (const gap of contentGaps) {
    lines.push(`- **${gap}**`);
  }
  lines.push('');

  lines.push('## 低KDキーワードパターン');
  lines.push('');
  lines.push('| パターン | 例 | 難易度 |');
  lines.push('|----------|-----|--------|');
  for (const p of INDUSTRY_KNOWLEDGE.lowKdPatterns) {
    lines.push(`| ${p.pattern} | \`${p.example}\` | ${p.difficulty} |`);
  }
  lines.push('');

  lines.push('## 費用相場参考');
  lines.push('');
  lines.push('| タイプ | 価格帯 | 説明 |');
  lines.push('|--------|--------|------|');
  for (const [key, val] of Object.entries(INDUSTRY_KNOWLEDGE.priceRanges)) {
    lines.push(`| ${val.description} | ${val.min}〜${val.max}${val.unit} | ${val.description} |`);
  }
  lines.push('');

  lines.push('## 参照事例');
  lines.push('');
  for (const site of INDUSTRY_KNOWLEDGE.caseStudySites) {
    lines.push(`- [${site.label}](${site.url})`);
  }
  lines.push('');

  return lines.join('\n');
}

function formatDraftReport(draft) {
  return draft;
}

// ─── Main ───

async function main() {
  const opts = parseArgs();

  const results = [];

  if (opts.research) {
    const data = mockKeywordResearch(opts.kw);
    const report = formatResearchReport(data);
    results.push({ section: 'keyword-research', content: report });
    console.error(`[X-0018] ✅ Keyword research complete: ${opts.kw}`);
  }

  if (opts.draft) {
    const draft = mockContentDraft(opts.kw, opts.intent);
    results.push({ section: 'content-draft', content: draft });
    console.error(`[X-0018] ✅ Content draft generated: ${opts.kw}`);
  }

  const output = results.map(r => r.content).join('\n\n---\n\n');

  if (opts.output) {
    writeFileSync(opts.output, output, 'utf-8');
    console.error(`[X-0018] ✅ Output written to: ${opts.output}`);
  } else {
    console.log(output);
  }
}

// ─── Tests ───

function runTests() {
  console.error('Running X-0018 tests...');

  // Test mockKeywordResearch
  const research = mockKeywordResearch('展示会 ブース 制作 費用');
  assert.ok(research.analysis, 'research.analysis should exist');
  assert.ok(research.analysis.targetKeyword === '展示会 ブース 制作 費用', 'keyword matches');
  assert.ok(research.groups.length === 3, '3 groups');
  assert.ok(research.competitorAnalysis.length === 3, '3 competitors analyzed');
  assert.ok(research.contentGaps.length >= 3, 'at least 3 content gaps');

  // Test mockContentDraft
  const draft = mockContentDraft('展示会 初めて ブース 費用', '情報収集');
  assert.ok(draft.includes('[SCREENSHOT:'), 'draft contains SCREENSHOT placeholder');
  assert.ok(draft.includes('[MY TAKE:'), 'draft contains MY TAKE placeholder');
  assert.ok(draft.includes('よくある質問（FAQ）'), 'draft contains FAQ section');
  assert.ok(draft.includes('Q1.'), 'draft contains FAQ items');
  assert.ok(draft.includes('title:'), 'draft has frontmatter');

  // Test formatResearchReport
  const report = formatResearchReport(research);
  assert.ok(report.includes('# キーワード分析レポート'), 'report has title');
  assert.ok(report.includes('推定キーワード難易度'), 'report includes difficulty');
  assert.ok(report.includes('コンテンツギャップ'), 'report includes gaps');

  // Test resolveOutputPath
  const testDir = resolve('C:/Users/kimko/.claude/auto-session-repo/outputs/X-0018');
  const testPath = resolveOutputPath(`${testDir}/_test-output.md`);
  // cleanup
  try { writeFileSync(testPath, ''); } catch {}

  console.error('All X-0018 tests passed ✅');
}

// ─── Entry ───

if (process.argv[1] && process.argv[1].endsWith('x0018-seo-content-pipeline.mjs')) {
  if (process.argv.includes('--test')) {
    runTests();
    process.exit(0);
  }
  main().catch(err => {
    console.error('Fatal:', err.message);
    process.exit(1);
  });
}

export { mockKeywordResearch, mockContentDraft, formatResearchReport, INDUSTRY_KNOWLEDGE };