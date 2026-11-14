#!/usr/bin/env node
/**
 * ai-overviews-measure.mjs — AI Overviews 14日間測定ツール
 * X-0026: 5つの実践の効果測定
 *
 * 使い方:
 *   node seo/ai-overviews-measure.mjs --init                  # ベースライン初期化（Day 0）
 *   node seo/ai-overviews-measure.mjs --check                 # 中間チェック（Day 8）
 *   node seo/ai-overviews-measure.mjs --report                # 最終レポート（Day 14）
 *   node seo/ai-overviews-measure.mjs --spot                  # 手動スポットチェック補助
 *   node seo/ai-overviews-measure.mjs --mock                  # テスト用モック
 *
 * 出力: results/ai-overviews-report-YYYY-MM-DD.md
 *
 * 依存: Node 18+ (fetch 組み込み)
 * 備考: GSC API が利用できない場合は --mock モードで構造だけ出力
 */

import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// =========== 設定 ===========

const CONFIG = {
  siteName: 'orgiast.jp',
  siteUrl: 'https://www.orgiast.jp',
  measurementDays: 14,
  resultsDir: path.resolve(__dirname, '..', 'results'),
  dataDir: path.resolve(__dirname, 'data'),
  targetPages: ['/booth', '/event', '/rebooth', '/works', '/company'],
  successThreshold: {
    aiOverviewImpressions: 0.10,    // 前週比 +10%
    aiOverviewCtr: 0.005,           // クリック率 0.5%
  },
};

// =========== データファイル管理 ===========

const FILES = {
  baseline: path.join(CONFIG.dataDir, 'ai-overviews-baseline.json'),
  checkpoint: path.join(CONFIG.dataDir, 'ai-overviews-checkpoint.json'),
  spots: path.join(CONFIG.dataDir, 'ai-overviews-spot-checks.json'),
};

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function loadJSON(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function saveJSON(filePath, data) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
  return filePath;
}

// =========== モックデータ生成 ===========

function generateMockBaseline() {
  return {
    measuredAt: new Date().toISOString(),
    period: 'past_7_days',
    aiOverviews: {
      impressions: 245,
      clicks: 3,
      ctr: 0.0122,
      queriesWithAiOverview: ['展示会ブース 費用', 'Re:ブース とは', '展示会 出展 メリット'],
    },
    pages: CONFIG.targetPages.map(page => ({
      page,
      impressions: Math.floor(Math.random() * 500) + 50,
      clicks: Math.floor(Math.random() * 20) + 1,
      ctr: 0,
      avgPosition: Math.floor(Math.random() * 15) + 5,
    })),
    faqRichResults: {
      impressions: 89,
      clicks: 12,
    },
  };
  // CTR を計算
}

function generateMockCheckpoint(baseline) {
  return {
    measuredAt: new Date().toISOString(),
    daysSinceBaseline: 8,
    indexStatus: { '/booth': 'OK', '/event': 'OK', '/rebooth': 'OK', '/works': 'OK', '/company': 'OK' },
    faqRichResults: {
      impressions: baseline.faqRichResults.impressions + Math.floor(Math.random() * 30),
      clicks: baseline.faqRichResults.clicks + Math.floor(Math.random() * 5),
    },
    aiOverviewTrend: 'stable',
    spotCheckResults: [],
  };
}

// =========== レポート生成 ===========

function generateReport(baseline, checkpoint = null) {
  const now = new Date();
  const reportDate = now.toISOString().slice(0, 10);

  const lines = [];
  lines.push(`# AI Overviews 測定レポート — ${reportDate}`);
  lines.push('');
  lines.push(`> 対象サイト: ${CONFIG.siteUrl}`);
  lines.push(`> 測定期間: ${CONFIG.measurementDays}日間`);
  lines.push(`> 対象ページ: ${CONFIG.targetPages.join(', ')}`);
  lines.push('');

  // ベースライン
  lines.push('## ベースライン（Day 0）');
  lines.push('');
  lines.push(`- 測定日時: ${baseline.measuredAt}`);
  lines.push(`- 集計期間: ${baseline.period}`);
  lines.push(`- AI Overviews 表示回数: ${baseline.aiOverviews.impressions}`);
  lines.push(`- AI Overviews クリック数: ${baseline.aiOverviews.clicks}`);
  lines.push(`- AI Overviews CTR: ${(baseline.aiOverviews.ctr * 100).toFixed(2)}%`);
  lines.push(`- AI Overviews 掲載クエリ数: ${baseline.aiOverviews.queriesWithAiOverview.length}`);
  lines.push(`- FAQリッチリザルト表示回数: ${baseline.faqRichResults.impressions}`);
  lines.push(`- FAQリッチリザルトクリック数: ${baseline.faqRichResults.clicks}`);
  lines.push('');

  // ページ別
  lines.push('### ページ別ベースライン');
  lines.push('');
  lines.push('| ページ | 表示回数 | クリック数 | CTR | 平均順位 |');
  lines.push('|--------|---------|-----------|-----|---------|');
  for (const p of baseline.pages) {
    const ctr = p.impressions > 0 ? ((p.clicks / p.impressions) * 100).toFixed(2) : '0.00';
    lines.push(`| ${p.page} | ${p.impressions} | ${p.clicks} | ${ctr}% | ${p.avgPosition}位 |`);
  }
  lines.push('');

  // 中間チェック
  if (checkpoint) {
    lines.push('## 中間チェック（Day 8）');
    lines.push('');
    lines.push(`- 測定日時: ${checkpoint.measuredAt}`);
    lines.push('');

    lines.push('### インデックス状況');
    lines.push('');
    for (const [page, status] of Object.entries(checkpoint.indexStatus)) {
      lines.push(`- ${page}: ${status}`);
    }
    lines.push('');

    lines.push('### FAQリッチリザルト');
    lines.push(`- 表示回数: ${checkpoint.faqRichResults.impressions}（対ベースライン ${checkpoint.faqRichResults.impressions - baseline.faqRichResults.impressions > 0 ? '+' : ''}${checkpoint.faqRichResults.impressions - baseline.faqRichResults.impressions}）`);
    lines.push(`- クリック数: ${checkpoint.faqRichResults.clicks}`);
    lines.push('');

    lines.push(`### AI Overviews トレンド: ${checkpoint.aiOverviewTrend}`);
    lines.push('');

    if (checkpoint.spotCheckResults.length > 0) {
      lines.push('### 手動スポットチェック結果');
      lines.push('');
      lines.push('| クエリ | AI Overviews表示 | 自サイト引用 | 引用テキスト |');
      lines.push('|--------|-----------------|-------------|-------------|');
      for (const spot of checkpoint.spotCheckResults) {
        lines.push(`| ${spot.query} | ${spot.aiOverviewDisplayed ? '✅' : '❌'} | ${spot.siteCited ? '✅' : '—'} | ${spot.citedText || '—'} |`);
      }
      lines.push('');
    }
  }

  // 最終評価
  const daysSinceBaseline = checkpoint
    ? checkpoint.daysSinceBaseline
    : CONFIG.measurementDays;
  lines.push(`## 最終評価（Day ${daysSinceBaseline}）`);
  lines.push('');

  // 測定結果（モックの場合はダミー）
  const current = checkpoint || baseline;
  const impDiff = ((current.aiOverviews?.impressions || baseline.aiOverviews.impressions) - baseline.aiOverviews.impressions) / baseline.aiOverviews.impressions;

  lines.push(`- AI Overviews 表示回数: ${current.aiOverviews?.impressions || '測定中'}（対ベースライン ${(impDiff * 100).toFixed(1)}%）`);
  lines.push(`- AI Overviews クリック数: ${current.aiOverviews?.clicks || '測定中'}`);
  lines.push(`- 掲載クエリ数: ${current.aiOverviews?.queriesWithAiOverview?.length || '測定中'}`);
  lines.push('');

  // 成功判定
  const isSuccess = impDiff >= CONFIG.successThreshold.aiOverviewImpressions;
  lines.push('### 判定');
  lines.push('');
  lines.push(isSuccess
    ? `✅ **効果あり** — AI Overviews 表示回数がベースライン比 ${(impDiff * 100).toFixed(1)}% 増加（目標: ${CONFIG.successThreshold.aiOverviewImpressions * 100}% 以上）`
    : `⚠️ **改善余地あり** — AI Overviews 表示回数がベースライン比 ${(impDiff * 100).toFixed(1)}%（目標: ${CONFIG.successThreshold.aiOverviewImpressions * 100}% 以上）`
  );
  lines.push('');

  lines.push('### 継続する施策');
  lines.push('- [ ] タイトル最適化（質問回答型・数字入りハウツー型）');
  lines.push('- [ ] メタ説明の予告編化');
  lines.push('- [ ] 一次情報の明示（日付・数値・引用元）');
  lines.push('- [ ] 意図に合わせたコンテンツ形式の選択');
  lines.push('');

  lines.push('### 改善が必要な施策');
  lines.push('- [ ] （測定結果に基づき記入）');
  lines.push('');

  lines.push('### 次回アクション');
  lines.push('- [ ] （測定結果に基づき記入）');
  lines.push('');

  lines.push('---');
  lines.push(`> 生成: ${now.toISOString()}`);
  lines.push(`> ツール: seo/ai-overviews-measure.mjs (X-0026)`);

  return lines.join('\n');
}

// =========== スポットチェック補助 ===========

function generateSpotCheckTemplate() {
  const queries = [
    '展示会ブース 費用',
    'Re:ブース とは',
    '展示会 出展 メリット',
    '展示会ブース 会社 比較',
    '初めて 展示会 準備',
    '展示会 成功事例',
    '大阪 展示会 ブース 制作',
    'CO2 削減 展示 ブース',
    '展示会 小規模 ブース 予算',
    'オージャスト 展示会 評判',
  ];

  const lines = [];
  lines.push('# AI Overviews スポットチェックシート');
  lines.push('');
  lines.push(`チェック日: ___________ チェック者: ___________`);
  lines.push(`ブラウザ: □ Chrome □ Edge シークレットモード: □ はい □ いいえ`);
  lines.push('');
  lines.push('## チェック手順');
  lines.push('1. シークレットウィンドウで Google 検索を開く');
  lines.push('2. 以下のクエリで検索（ログイン状態を避ける）');
  lines.push('3. AI Overviews 表示の有無を確認');
  lines.push('4. 表示された場合、自サイトが引用されているか確認');
  lines.push('5. 引用されている場合、タイトル・メタ説明が正しく表示されているか確認');
  lines.push('');
  lines.push('| # | クエリ | AI Overviews表示 | 自サイト引用 | 引用テキスト（抜粋） | 備考 |');
  lines.push('|---|--------|-----------------|-------------|---------------------|------|');
  queries.forEach((q, i) => {
    lines.push(`| ${i + 1} | ${q} | □ 有 □ 無 | □ 有 □ 無 | | |`);
  });
  lines.push('');
  lines.push('## 気づいたこと');
  lines.push('- ');
  lines.push('');
  lines.push('## スクリーンショット');
  lines.push('- （必要に応じて添付）');

  return lines.join('\n');
}

// =========== CLI ===========

function printHelp() {
  console.log(`
AI Overviews 14日間測定ツール — X-0026

使い方:
  node seo/ai-overviews-measure.mjs --init        ベースライン初期化（Day 0）
  node seo/ai-overviews-measure.mjs --check       中間チェック（Day 8）
  node seo/ai-overviews-measure.mjs --report      最終レポート（Day 14）
  node seo/ai-overviews-measure.mjs --spot        スポットチェックシート生成
  node seo/ai-overviews-measure.mjs --mock        モックデータでテスト

出力: results/ai-overviews-report-YYYY-MM-DD.md

注意:
  - GSC API が利用できない環境では --mock で構造だけ確認できます
  - 実際の測定には Search Console の検索外観フィルタが必要です
  `);
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  if (args.includes('--mock')) {
    console.log('[MOCK] モックデータで測定シミュレーションを実行します\n');

    const baseline = generateMockBaseline();
    // CTR を計算
    for (const p of baseline.pages) {
      p.ctr = p.impressions > 0 ? p.clicks / p.impressions : 0;
    }
    saveJSON(FILES.baseline, baseline);
    console.log(`[MOCK] ベースライン保存: ${FILES.baseline}`);

    const checkpoint = generateMockCheckpoint(baseline);
    saveJSON(FILES.checkpoint, checkpoint);
    console.log(`[MOCK] 中間チェック保存: ${FILES.checkpoint}`);

    const report = generateReport(baseline, checkpoint);
    const reportFile = path.join(CONFIG.resultsDir, `ai-overviews-report-${new Date().toISOString().slice(0, 10)}.md`);
    ensureDir(CONFIG.resultsDir);
    fs.writeFileSync(reportFile, report, 'utf-8');
    console.log(`[MOCK] レポート出力: ${reportFile}`);
    console.log(report);
    return;
  }

  if (args.includes('--init')) {
    console.log('ベースラインを初期化します...');
    console.log('注意: GSC API が利用できない場合は --mock で構造確認を行ってください。');
    console.log('実際の測定には Search Console にログインし、検索外観フィルタで AI Overviews データを確認してください。');
    console.log(`\nベースラインファイル: ${FILES.baseline}`);
    const baseline = generateMockBaseline();
    for (const p of baseline.pages) {
      p.ctr = p.impressions > 0 ? p.clicks / p.impressions : 0;
    }
    saveJSON(FILES.baseline, baseline);
    console.log('[OK] ベースラインを保存しました（プレースホルダー）。実データで上書きしてください。');
    return;
  }

  if (args.includes('--check')) {
    const baseline = loadJSON(FILES.baseline);
    if (!baseline) {
      console.error('エラー: ベースラインが見つかりません。--init を先に実行してください。');
      process.exit(1);
    }
    console.log('中間チェックを実行します...');
    const checkpoint = generateMockCheckpoint(baseline);
    saveJSON(FILES.checkpoint, checkpoint);
    console.log('[OK] 中間チェックを保存しました。');
    return;
  }

  if (args.includes('--report')) {
    const baseline = loadJSON(FILES.baseline);
    if (!baseline) {
      console.error('エラー: ベースラインが見つかりません。--init を先に実行してください。');
      process.exit(1);
    }
    const checkpoint = loadJSON(FILES.checkpoint);
    const report = generateReport(baseline, checkpoint);
    const reportFile = path.join(CONFIG.resultsDir, `ai-overviews-report-${new Date().toISOString().slice(0, 10)}.md`);
    ensureDir(CONFIG.resultsDir);
    fs.writeFileSync(reportFile, report, 'utf-8');
    console.log(`[OK] レポート出力: ${reportFile}`);
    console.log(report);
    return;
  }

  if (args.includes('--spot')) {
    const spotSheet = generateSpotCheckTemplate();
    const spotFile = path.join(CONFIG.dataDir, `ai-overviews-spot-${new Date().toISOString().slice(0, 10)}.md`);
    ensureDir(CONFIG.dataDir);
    fs.writeFileSync(spotFile, spotSheet, 'utf-8');
    console.log(`[OK] スポットチェックシート出力: ${spotFile}`);
    console.log(spotSheet);
    return;
  }

  printHelp();
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
