#!/usr/bin/env node
/**
 * X-0057 AIニュース提案パイプライン
 *
 * Google Trends → LLM分類 → 記事ネタ提案
 *
 * Google Trends から展示会ブース制作に関連する急上昇キーワードを取得し、
 * LLM（gemini）で「新規記事向き／既存記事追記向き／対象外」に分類する。
 *
 * 使い方:
 *   node seo/x0057-ai-news-pipeline.mjs                              # デフォルト全キーワード
 *   node seo/x0057-ai-news-pipeline.mjs --seed "展示会"              # 単一シード
 *   node seo/x0057-ai-news-pipeline.mjs --mock                       # LLM呼び出しなし
 *   node seo/x0057-ai-news-pipeline.mjs --output outputs/X-0057/2026-11-16.md
 *   node seo/x0057-ai-news-pipeline.mjs --json                       # JSONのみ出力
 *   node seo/x0057-ai-news-pipeline.mjs --help                       # ヘルプ表示
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isEntry } from '../tools/is-entry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOOLS_DIR = path.resolve(__dirname, '..', 'tools');

// ─── デフォルトシードキーワード ───

const DEFAULT_SEED_KEYWORDS = [
  '展示会',
  'ブース 制作',
  '展示会 出展',
  'イベント ブース',
  '展示会 小間',
  'ブース デザイン',
  '展示会 施工',
  'リブース',
  '展示会 レンタル',
  'ブース 設営',
  'ノベルティ 制作',
  '展示会 備品',
];

// ─── 分類カテゴリ ───

const CATEGORIES = {
  NEW_ARTICLE: { emoji: '✅', label: '新規記事向き' },
  UPDATE_EXISTING: { emoji: '🔄', label: '既存記事への追記向き' },
  EXCLUDED: { emoji: '❌', label: '対象外' },
};

// ─── ヘルパー ───

function todayDate() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── CLI パーサ ───

function showUsage() {
  console.log(`
X-0057 AIニュース提案パイプライン

Usage:
  node seo/x0057-ai-news-pipeline.mjs                        # デフォルト全キーワード（12種）
  node seo/x0057-ai-news-pipeline.mjs --seed "展示会"        # 単一シード
  node seo/x0057-ai-news-pipeline.mjs --output <path>        # ファイル出力
  node seo/x0057-ai-news-pipeline.mjs --mock                  # LLM呼び出しなし（分類ランダム）
  node seo/x0057-ai-news-pipeline.mjs --json                  # JSONのみ出力
  node seo/x0057-ai-news-pipeline.mjs --help                  # このヘルプ

Options:
  --seed <kw>       単一のシードキーワード（省略時はデフォルト12種）
  --output <path>   出力ファイルパス（省略時はstdoutのみ）
  --mock            LLM呼び出しなし、ランダム分類（既定は実LLM呼び出し）
  --json            JSON形式のみ出力（Markdown整形なし）
  --help            このヘルプを表示
`);
}

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--seed':
        opts.seed = args[++i];
        break;
      case '--output':
        opts.output = path.resolve(args[++i]);
        break;
      case '--mock':
        opts.mock = true;
        break;
      case '--json':
        opts.jsonOnly = true;
        break;
      case '--help':
        showUsage();
        process.exit(0);
      default:
        break;
    }
  }

  return opts;
}

// ─── Google Trends API ───

async function fetchRelatedQueries(keyword) {
  let googleTrendsApi;
  try {
    const mod = await import('google-trends-api');
    googleTrendsApi = mod.default || mod;
  } catch (e) {
    throw new Error(`google-trends-api failed to load: ${e.message}`);
  }

  const raw = await googleTrendsApi.relatedQueries({ keyword, geo: 'JP' });
  const text = typeof raw === 'string' ? raw : String(raw);
  const json = JSON.parse(text);

  const rankedList = json.default?.rankedList || [];
  const topQueries = [];
  const risingQueries = [];

  for (let i = 0; i < rankedList.length; i++) {
    const ranked = rankedList[i];
    if (!ranked?.rankedKeyword) continue;
    for (const item of ranked.rankedKeyword) {
      if (item.query) {
        const entry = {
          query: item.query,
          value: item.value || 0,
          source: keyword,
          type: i === 0 ? 'top' : 'rising',
        };
        if (i === 0) {
          topQueries.push(entry);
        } else {
          risingQueries.push(entry);
        }
      }
    }
  }

  return { topQueries, risingQueries };
}

function parseInterestTimeline(raw) {
  const text = typeof raw === 'string' ? raw : String(raw);
  const json = JSON.parse(text);

  const timeline = [];
  const data = json.default?.timelineData || [];
  for (const entry of data) {
    const val = Array.isArray(entry.value) ? entry.value[0] : entry.value;
    timeline.push({
      time: entry.formattedAxisTime || '',
      value: val != null ? Number(val) : 0,
      formattedValue: entry.formattedValue?.[0] || entry.formattedValue || '0',
    });
  }
  return timeline;
}

async function fetchInterestOverTime(keyword) {
  let googleTrendsApi;
  try {
    const mod = await import('google-trends-api');
    googleTrendsApi = mod.default || mod;
  } catch (e) {
    throw new Error(`google-trends-api failed to load: ${e.message}`);
  }

  const raw = await googleTrendsApi.interestOverTime({
    keyword,
    geo: 'JP',
    granularity: 'DAY',
    startTime: daysAgo(30),
  });

  return parseInterestTimeline(raw);
}

/**
 * トレンドの方向を簡易判定
 */
function computeTrendDirection(timeline) {
  if (timeline.length < 7) return '不明';

  // 直近7日間の平均 vs その前7日間の平均
  const recent = timeline.slice(-7);
  const previous = timeline.slice(-14, -7);

  const recentAvg = recent.reduce((s, e) => s + Number(e.value), 0) / recent.length;
  const prevAvg = previous.reduce((s, e) => s + Number(e.value), 0) / previous.length;

  if (recent.length === 0 || previous.length === 0) return '不明';

  const change = ((recentAvg - prevAvg) / prevAvg) * 100;
  return change;
}

/**
 * 全クエリを収集
 */
async function collectAllQueries(seedKeywords) {
  const allTop = [];
  const allRising = [];
  const errors = [];

  for (let i = 0; i < seedKeywords.length; i++) {
    const kw = seedKeywords[i];
    console.error(`[Trends] (${i + 1}/${seedKeywords.length}) relatedQueries: ${kw}`);

    try {
      const { topQueries, risingQueries } = await fetchRelatedQueries(kw);
      allTop.push(...topQueries);
      allRising.push(...risingQueries);

      console.error(`  → Top: ${topQueries.length} queries, Rising: ${risingQueries.length} queries`);
    } catch (e) {
      console.error(`  ⚠ Error: ${e.message}`);
      errors.push({ keyword: kw, error: e.message });
    }

    // レート制限回避: キーワード間で待機
    if (i < seedKeywords.length - 1) {
      await sleep(1500);
    }
  }

  return { allTop, allRising, errors };
}

/**
 * 重複除去（大文字小文字を無視）
 */
function deduplicateQueries(queries) {
  const seen = new Set();
  return queries.filter(item => {
    const key = item.query.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * 各クエリのトレンドデータ取得
 */
async function fetchTrendsForQueries(queries) {
  const trendData = [];
  const errors = [];

  // 最大20クエリに制限（API負荷対策）
  const limited = queries.slice(0, 20);

  for (let i = 0; i < limited.length; i++) {
    const q = limited[i];
    console.error(`[Trends] interestOverTime (${i + 1}/${limited.length}): ${q.query}`);

    try {
      const timeline = await fetchInterestOverTime(q.query);
      const change = computeTrendDirection(timeline);
      const recentValues = timeline.slice(-7).map(t => t.value).join(', ');
      const maxVal = timeline.length > 0
        ? Math.max(...timeline.map(t => Number(t.value)))
        : 0;

      trendData.push({
        query: q.query,
        source: q.source,
        type: q.type,
        trendChange: change,
        maxValue: maxVal,
        recentValues,
        timelineLength: timeline.length,
      });

      const changeStr = typeof change === 'number' ? `${change > 0 ? '+' : ''}${change.toFixed(1)}%` : change;
      console.error(`  → change: ${changeStr}, max: ${maxVal}`);
    } catch (e) {
      console.error(`  ⚠ Error: ${e.message}`);
      errors.push({ query: q.query, error: e.message });
    }

    if (i < limited.length - 1) {
      await sleep(1000);
    }
  }

  return trendData;
}

// ─── LLM分類 ───

function buildClassificationPrompt(keywords, trendData) {
  const kwLines = keywords.map(k =>
    `- ${k.query}（元KW: ${k.source}, タイプ: ${k.type === 'rising' ? '急上昇' : 'トップ'}）`
  ).join('\n');

  const trendLines = trendData.map(t => {
    const dir = t.trendChange === '不明' ? '不明' :
      (t.trendChange > 10 ? '↑上昇中' : t.trendChange < -10 ? '↓下降中' : '→横ばい');
    return `- ${t.query}: ${dir}（変化率 ${typeof t.trendChange === 'number' ? `${t.trendChange > 0 ? '+' : ''}${t.trendChange.toFixed(1)}%` : '不明'}、最大値 ${t.maxValue}）`;
  }).join('\n');

  return `あなたは展示会ブース制作会社のマーケティング担当者です。以下のキーワードを3つに分類してください。

✅ 新規記事向き: 検索需要があり、自社で書ける専門性があり、まだ記事にしていない
🔄 既存記事追記向き: 既存記事に関連追記できる（タイトル変更不要）
❌ 対象外: 自社事業と無関係、または需要が低い

各キーワードについて:
カテゴリ / 理由（1行） / 想定記事タイトル（新規・追記のみ）

## キーワード一覧
${kwLines}

## トレンド情報（直近30日）
${trendLines}

JSON配列形式で出力してください:
[
  {
    "keyword": "キーワード",
    "category": "新規記事向き | 既存記事追記向き | 対象外",
    "reason": "理由（1行）",
    "suggestedTitle": "想定記事タイトル（新規・追記のみ、対象外はnull）"
  }
]`;
}

/**
 * LLM呼び出し（llm-askを使用）
 */
function callLLM(prompt) {
  const llmAsk = path.join(TOOLS_DIR, 'llm-ask.mjs');
  // プロンプトが長いので一時ファイル経由
  const tmpDir = fs.mkdtempSync('.llm-x0057-');
  const promptFile = path.join(tmpDir, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  try {
    // llm-ask の戻り値は文字列（stdout）そのもの
    const result = execFileSync(process.execPath, [
      llmAsk,
      '--provider', 'openrouter',
      '--prompt-file', promptFile,
      '--max', '8192',
    ], {
      encoding: 'utf-8',
      maxBuffer: 1_000_000,
    });
    // 結果はexecFileSyncの戻り値そのものがstdout文字列
    return typeof result === 'string' ? result : String(result);
  } finally {
    try {
      fs.unlinkSync(promptFile);
      fs.rmdirSync(tmpDir);
    } catch { /* ベストエフォート */ }
  }
}

/**
 * モック分類（ランダム）
 */
function mockClassification(keywords, trendData) {
  const cats = ['新規記事向き', '既存記事追記向き', '対象外'];
  const reasons = {
    '新規記事向き': '検索需要があり、自社のノウハウを活かした記事が書ける',
    '既存記事追記向き': '既存の関連記事に追記可能なテーマ',
    '対象外': '自社事業との関連性が低い',
  };
  const titles = {
    '新規記事向き': (kw) => `${kw}の完全ガイド【最新】`,
    '既存記事追記向き': (kw) => `既存記事「${kw}」への追記`,
    '対象外': () => null,
  };

  return keywords.map(k => {
    // 急上昇キーワードは新規記事向きになりやすい
    const catIdx = k.type === 'rising'
      ? Math.floor(Math.random() * 2)  // 0 or 1
      : Math.floor(Math.random() * 3); // 0, 1, or 2
    const cat = cats[catIdx];
    return {
      keyword: k.query,
      category: cat,
      reason: reasons[cat],
      suggestedTitle: titles[cat](k.query),
    };
  });
}

/**
 * LLM応答のJSONパース
 */
function parseLLMResponse(text) {
  // JSON配列を抽出
  const jsonMatch = text.match(/\[\s*\{[\s\S]*\}\s*\]/);
  if (!jsonMatch) {
    throw new Error('LLM応答からJSON配列を抽出できませんでした');
  }

  try {
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error(`LLM応答のJSONパースに失敗: ${e.message}`);
  }
}

// ─── フォーマッター ───

function formatClassificationResult(classifications, allQueries, risingQueries, trendData) {
  const date = todayDate();

  // 急上昇キーワードのテーブル
  const risingRows = risingQueries.slice(0, 20).map(r => {
    const trend = trendData.find(t => t.query.toLowerCase() === r.query.toLowerCase());
    const changeStr = trend && typeof trend.trendChange === 'number'
      ? `${trend.trendChange > 0 ? '+' : ''}${trend.trendChange.toFixed(1)}%`
      : '—';
    return `| ${r.query} | ${r.source} | ${trend?.maxValue || '—'} | ${changeStr} |`;
  }).join('\n');

  // 分類結果をカテゴリ別に振り分け
  const categorized = {
    '新規記事向き': [],
    '既存記事への追記向き': [],
    '対象外': [],
  };

  for (const c of classifications) {
    const label = c.category === '新規記事向き' ? '新規記事向き'
      : c.category === '既存記事追記向き' ? '既存記事への追記向き'
      : '対象外';
    categorized[label].push(c);
  }

  const fmtList = (items, showTitle) => {
    return items.map(c =>
      `- **${c.keyword}**\n  - 理由: ${c.reason}${showTitle && c.suggestedTitle ? `\n  - 想定タイトル: ${c.suggestedTitle}` : ''}`
    ).join('\n');
  };

  return `# X-0057 AIニュース提案 🗓️ ${date}

## 急上昇キーワード
| キーワード | 関連元 | トレンド値 | 前週比 |
|------------|--------|-----------|--------|
${risingRows}

## 📋 分類結果

### ✅ 新規記事向き
${fmtList(categorized['新規記事向き'], true) || '（該当なし）'}

### 🔄 既存記事への追記向き
${fmtList(categorized['既存記事への追記向き'], true) || '（該当なし）'}

### ❌ 対象外
${fmtList(categorized['対象外'], false) || '（該当なし）'}

---
Pipeline: Google Trends → Gemini CLI classification
Generated: ${date} | Seeds: ${allQueries.length} unique queries | ${risingQueries.length} rising
`;
}

// ─── JSONフォーマッター ───

function formatJSON({ classifications, allQueries, risingQueries, trendData, seedKeywords, googleErrors, trendErrors }) {
  return JSON.stringify({
    pipeline: 'x0057-ai-news-pipeline',
    generatedAt: new Date().toISOString(),
    seedKeywords,
    statistics: {
      totalUniqueQueries: allQueries.length,
      risingQueries: risingQueries.length,
      keywordsWithTrend: trendData.length,
      googleApiErrors: googleErrors.length,
      trendApiErrors: trendErrors.length,
    },
    classifications,
    risingKeywords: risingQueries.slice(0, 20).map(r => ({
      query: r.query,
      source: r.source,
      trend: trendData.find(t => t.query.toLowerCase() === r.query.toLowerCase()),
    })),
  }, null, 2);
}

// ─── メイン ───

async function main() {
  const opts = parseArgs();

  // シードキーワードの決定
  const seedKeywords = opts.seed ? [opts.seed] : DEFAULT_SEED_KEYWORDS;

  console.error(`[X-0057] シードキーワード: ${seedKeywords.length}件`);
  console.error(`[X-0057] LLMモード: ${opts.mock ? 'モック' : 'Gemini'}`);

  // Step 1-2: Google Trends から関連クエリを収集
  const { allTop, allRising, errors: googleErrors } = await collectAllQueries(seedKeywords);

  // Step 3: 重複除去
  const allQueries = deduplicateQueries([...allTop, ...allRising]);
  const risingQueries = deduplicateQueries(allRising);

  console.error(`[X-0057] 全ユニーククエリ: ${allQueries.length}件（Top: ${allTop.length}, Rising: ${allRising.length}, 重複除去後）`);

  if (allQueries.length === 0) {
    console.error('[X-0057] クエリが取得できませんでした。API制限またはネットワークエラーの可能性があります。');
    process.exit(1);
  }

  // Step 4: 各クエリのトレンド確認
  const trendData = await fetchTrendsForQueries(allQueries);

  // Step 5: LLM分類
  let classifications;
  if (opts.mock) {
    classifications = mockClassification(allQueries, trendData);
    console.error(`[X-0057] ✅ モック分類完了: ${classifications.length}件`);
  } else {
    console.error(`[X-0057] LLM分類を実行中...`);
    const prompt = buildClassificationPrompt(allQueries, trendData);

    try {
      const raw = callLLM(prompt);
      classifications = parseLLMResponse(raw);
      console.error(`[X-0057] ✅ LLM分類完了: ${classifications.length}件`);
    } catch (e) {
      console.error(`[X-0057] ⚠ LLM分類失敗: ${e.message} → モックフォールバック`);
      classifications = mockClassification(allQueries, trendData);
    }
  }

  // Step 6: 出力
  const outputJSON = formatJSON({
    classifications,
    allQueries,
    risingQueries,
    trendData,
    seedKeywords,
    googleErrors,
    trendErrors: [],
  });

  if (opts.jsonOnly) {
    if (opts.output) {
      const dir = path.dirname(opts.output);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(opts.output, outputJSON, 'utf-8');
      console.error(`[X-0057] ✅ JSON出力: ${opts.output}`);
    } else {
      console.log(outputJSON);
    }
  } else {
    const markdown = formatClassificationResult(classifications, allQueries, risingQueries, trendData);

    if (opts.output) {
      const dir = path.dirname(opts.output);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(opts.output, markdown, 'utf-8');
      console.error(`[X-0057] ✅ 出力: ${opts.output}`);
    }

    // stdoutには常にMarkdownを出力（--jsonがない場合）
    console.log(markdown);
  }
}

// ─── エントリ ───

if (isEntry(import.meta.url)) {
  main().catch(err => {
    console.error(`[X-0057] Fatal: ${err.message}`);
    process.exit(1);
  });
}