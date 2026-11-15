#!/usr/bin/env node
/**
 * ga4-ai-pipeline.mjs — GA4データ→AI分析→改善提案のパイプライン
 *
 * 目的: GA4 + Search Console のデータを AI (Gemini/Claude/Groq) に渡し、
 * 展示会ブース制作サイト orgiast.jp の SEO/AIO 改善提案を自動生成する。
 *
 * 使い方:
 *   node seo/ga4-ai-pipeline.mjs --ga4-csv ./data/ga4-pages.csv --gsc-csv ./data/gsc-queries.csv
 *   node seo/ga4-ai-pipeline.mjs --mock                         # テスト用モックデータ
 *   node seo/ga4-ai-pipeline.mjs --mock --verbose                # 詳細ログ
 *
 * 出力: stdout に改善提案(Markdown)、または --output <file> で保存
 *
 * 依存: Node 18+ (fetch 組み込み)
 *
 * 注意:
 * - GA4データが溜まるまでは --mock モードで動作確認可能
 * - AIプロバイダは環境変数 AI_PROVIDER で切替 (gemini / groq / claude)
 * - デフォルトは Gemini (一番安価)
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
  businessType: '展示会ブース制作・イベント企画制作',
  // AIプロバイダ: gemini | groq | claude
  provider: process.env.AI_PROVIDER || 'gemini',
  // モデル
  models: {
    gemini: 'gemini-2.0-flash',
    groq: 'deepseek-r1-distill-llama-70b',
    claude: 'claude-3-haiku-20240307',
  },
};

// =========== 分析プロンプトテンプレート ===========

function buildPrompt({ ga4Data = '', gscData = '', siteAnalysis = '' }) {
  return `あなたはSEO/AIOアナリストです。以下のGA4データとSearch Consoleデータから、展示会ブース制作サイト（${CONFIG.siteUrl}）の改善提案をしてください。

## サイト情報
- 事業内容: ${CONFIG.businessType}
- 強み: 全国7拠点、大阪・関西万博パビリオン制作実績、Re:ブース（CO2 77%削減）
- 対象ページ: トップページ /booth /event /works /rebooth /company

## GA4データ（直近28日）
${ga4Data}

## Search Consoleデータ（直近28日）
${gscData}

## サイト現状分析
${siteAnalysis}

## 分析してほしいこと
1. 流入が多いのにコンバージョンが低いページ（改善優先度大）
2. 検索順位が5-20位でクリック率が低いクエリ（タイトル・メタ記述改善候補）
3. 展示会・ブース制作の検索意図に合っていないページ
4. AI（LLM）に引用されやすいページとされにくいページの差
5. 競合サイトと比較したコンテンツの不足領域
6. JSON-LD構造化データの不足（現状: Organization/WebSite/FAQPage3問のみ）

## 出力形式
- 改善提案を優先度順（P0/P1/P2）に列挙
- 各提案に「期待効果（低/中/高）」と「実装難易度（1-5）」を付ける
- タイトル・H1・H2の具体的な修正案を含める
- JSON-LD追加提案を含める

## 禁止事項
- 事実の捏造（存在しない事例・価格・在庫の創作）
- 競合サイト名の不必要開示
- 法的効力のない保証（「必ず1位」など）`;
}

// =========== モックデータ生成 ===========

function generateMockData() {
  const ga4Pages = [
    { page: '/', views: 1520, avgTime: '2:35', bounceRate: '58%' },
    { page: '/booth', views: 890, avgTime: '3:12', bounceRate: '45%' },
    { page: '/event', views: 670, avgTime: '2:55', bounceRate: '52%' },
    { page: '/works', views: 430, avgTime: '4:20', bounceRate: '35%' },
    { page: '/company', views: 310, avgTime: '1:50', bounceRate: '62%' },
    { page: '/rebooth', views: 520, avgTime: '3:45', bounceRate: '40%' },
  ];

  const gscQueries = [
    { query: '展示会ブース制作 大阪', clicks: 45, impressions: 890, position: 4.2 },
    { query: '展示会 ブース デザイン 会社', clicks: 32, impressions: 720, position: 5.8 },
    { query: 'イベント企画 会社 大阪', clicks: 28, impressions: 650, position: 3.5 },
    { query: '社内イベント 企画 代行', clicks: 55, impressions: 1200, position: 2.1 },
    { query: '展示会 出展 準備 スケジュール', clicks: 8, impressions: 340, position: 7.5 },
    { query: 'サステナブル ブース 制作', clicks: 12, impressions: 180, position: 6.2 },
    { query: 'Re:ブース', clicks: 65, impressions: 420, position: 1.5 },
    { query: '大阪 万博 パビリオン 制作', clicks: 22, impressions: 510, position: 3.8 },
    { query: 'ブース 制作 料金 相場', clicks: 5, impressions: 280, position: 9.1 },
    { query: '中小企業 展示会 出展 コツ', clicks: 3, impressions: 95, position: 11.3 },
  ];

  const siteAnalysis = `- タイトル: ${CONFIG.siteName} — 「社内イベント企画プロデュース」が先頭、展示会KWない
- メタディスクリプション: 社内イベント・オンラインイベント中心、展示会ブース制作の言及なし
- H1: 画像ベースでテキストH1なし → アクセシビリティ・SEO上の課題
- robots.txt: WP管理画面のみDisallow、AIクローラーへの特別許可なし
- sitemap.xml: All in One SEO Pack 2.11 で生成済み
- JSON-LD: Organization・WebSite・FAQPage(3問)のみ → Service/Article/BreadcrumbListなし
- GA4: 未導入（UA-26359261-1 のみ、2024年7月計測停止）
- GTM: GTM-PF9V8SR 稼働中（GA4タグ追加のみで導入可能）
- 構造: WordPress + Apache + PHP 7.4`;

  return { ga4Pages, gscQueries, siteAnalysis };
}

// =========== AIプロバイダ呼び出し ===========

async function callAI(prompt, provider) {
  const apiKey = process.env[provider === 'gemini' ? 'GEMINI_API_KEY' :
                      provider === 'groq' ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY'];

  if (!apiKey && !process.env.MOCK_AI) {
    throw new Error(`${provider} API key not set. Set ${provider === 'gemini' ? 'GEMINI_API_KEY' : provider === 'groq' ? 'GROQ_API_KEY' : 'ANTHROPIC_API_KEY'} or use MOCK_AI=1`);
  }

  if (process.env.MOCK_AI) {
    return `## AI分析結果（モック）\n\n` +
      `※ ${provider} APIキー未設定のためモック応答です。\n\n` +
      `### P0: 優先度 高\n\n` +
      `1. **タイトルタグの最適化**\n   - 現状: 「社内イベント企画プロデュース、オンラインイベント、クリエイティブ制作の株式会社オージャスト」\n   - 改善案: 「展示会ブース制作・イベント企画 | 大阪・東京・福岡 株式会社オージャスト」\n   - 期待効果: 高 / 難易度: 1\n\n` +
      `2. **GA4導入とイベント計測基盤の構築**\n   - GTM-PF9V8SR経由でGA4タグを追加する\n   - 展示会CTAのクリックイベント設定\n   - 期待効果: 高 / 難易度: 2\n\n` +
      `### P1: 優先度 中\n\n` +
      `3. **FAQPage JSON-LD拡充**\n   - 現状3問→20問に拡充\n   - 期待効果: 中 / 難易度: 2\n\n` +
      `4. **メタディスクリプションの全面的書き換え**\n   - 展示会ブース制作・Re:ブースKWを含める\n   - 期待効果: 中 / 難易度: 1\n\n` +
      `### P2: 優先度 低\n\n` +
      `5. **BreadcrumbList JSON-LD追加**\n   - パンくずリストの構造化データ\n   - 期待効果: 低 / 難易度: 3\n\n` +
      `6. **Serviceスキーマ追加**\n   - 各サービスページにService型JSON-LD\n   - 期待効果: 中 / 難易度: 3`;
  }

  // ---- Gemini ----
  if (provider === 'gemini') {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.models.gemini}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
        }),
      },
    );
    const json = await resp.json();
    return json?.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(json);
  }

  // ---- Groq ----
  if (provider === 'groq') {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: CONFIG.models.groq,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        max_tokens: 4096,
      }),
    });
    const json = await resp.json();
    return json?.choices?.[0]?.message?.content || JSON.stringify(json);
  }

  throw new Error(`Unsupported provider: ${provider}`);
}

// =========== CSVパーサ ===========

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return '';
  const headers = lines[0].split(',');
  const rows = lines.slice(1).map(l => {
    const vals = l.split(',');
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (vals[i] || '').trim(); });
    return obj;
  });
  return rows.map(r => JSON.stringify(r)).join('\n');
}

// =========== メイン ===========

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set();
  let ga4Csv, gscCsv, outputPath;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--mock': flags.add('mock'); break;
      case '--verbose': flags.add('verbose'); break;
      case '--ga4-csv': ga4Csv = args[++i]; break;
      case '--gsc-csv': gscCsv = args[++i]; break;
      case '--output': outputPath = args[++i]; break;
      case '--help':
      case '-h':
        console.log(`GA4→AI分析パイプライン

使い方:
  node seo/ga4-ai-pipeline.mjs --mock             モックデータでテスト
  node seo/ga4-ai-pipeline.mjs --ga4-csv <file> --gsc-csv <file>  実データ
  node seo/ga4-ai-pipeline.mjs --mock --output report.md  ファイル出力

環境変数:
  AI_PROVIDER    AIプロバイダ (gemini / groq / claude, 既定: gemini)
  GEMINI_API_KEY Gemini API key
  GROQ_API_KEY   Groq API key
  MOCK_AI        1 でAI呼び出しをモック（テスト用）
`);
        return;
    }
  }

  // データ準備
  let ga4Data, gscData, siteAnalysis;

  if (flags.has('mock')) {
    const mock = generateMockData();
    ga4Data = JSON.stringify(mock.ga4Pages, null, 2);
    gscData = JSON.stringify(mock.gscQueries, null, 2);
    siteAnalysis = mock.siteAnalysis;
    if (flags.has('verbose')) {
      console.error(`[MOCK] GA4ページ数: ${mock.ga4Pages.length}`);
      console.error(`[MOCK] GSCクエリ数: ${mock.gscQueries.length}`);
    }
  } else {
    if (!ga4Csv || !gscCsv) {
      console.error('エラー: --ga4-csv と --gsc-csv を指定するか、--mock でテスト');
      process.exit(1);
    }
    ga4Data = parseCSV(fs.readFileSync(ga4Csv, 'utf-8'));
    gscData = parseCSV(fs.readFileSync(gscCsv, 'utf-8'));
    siteAnalysis = generateMockData().siteAnalysis;
  }

  // AI分析
  const prompt = buildPrompt({ ga4Data, gscData, siteAnalysis });
  const provider = CONFIG.provider;

  if (flags.has('verbose')) {
    console.error(`[INFO] プロバイダ: ${provider}`);
    console.error(`[INFO] プロンプト長: ${prompt.length} 文字`);
  }

  const result = await callAI(prompt, provider);

  // レポート生成
  const report = `# GA4×AI 改善提案レポート

**サイト**: ${CONFIG.siteUrl}
**生成日**: ${new Date().toISOString().slice(0, 10)}
**AIプロバイダ**: ${provider}

---

${result}

---

## データソース
| 項目 | 状態 |
|------|------|
| GA4 | ${ga4Csv ? `\`${ga4Csv}\`` : '（モックデータ）'} |
| Search Console | ${gscCsv ? `\`${gscCsv}\`` : '（モックデータ）'} |
| サイト分析 | 実測ベース |

## 次のアクション
1. GA4プロパティ作成 + GTMタグ追加（15分）
2. UA直書きコード削除（5分）
3. GA4データが溜まり次第、再実行
`;

  if (outputPath) {
    fs.writeFileSync(outputPath, report, 'utf-8');
    console.log(`✅ レポート保存: ${outputPath}`);
  } else {
    console.log(report);
  }
}

// =========== エントリ ===========

// エントリポイント
// 直接実行時のみ main() を呼ぶ（importされた時は自動実行しない）
// Windowsの file:// URL 正規化は複雑なため、process.env で簡易判定
const isMainScript = process.argv[0]?.replace(/\\/g, '/').includes('/seo/ga4-ai-pipeline.mjs');
if (isMainScript || process.argv[1] === '--mock' || process.argv[1] === '--help' || process.argv[1] === '-h') {
  main().catch(e => {
    console.error(`エラー: ${e.message}`);
    process.exit(1);
  });
}

export { buildPrompt, generateMockData, callAI, CONFIG };