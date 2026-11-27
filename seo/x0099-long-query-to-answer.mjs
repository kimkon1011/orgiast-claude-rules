#!/usr/bin/env node
/**
 * X-0099 長文クエリ → 見出し＋即答ツール
 *
 * Google Search Console から10語以上のクエリを抽出し、
 * 上位N件の見出し案と2〜4文の即答案をLLM生成する。
 * 収益ページ向けに価格・時期・要件・代替・比較の小見出しを分けて出力する。
 *
 * 使い方:
 *   # GSC データファイル（export-search-console.mjs の出力）から分析
 *   node seo/x0099-long-query-to-answer.mjs --input seo/Queries.csv --site "https://www.orgiast.jp/"
 *
 *   # 上位20件のみ、LLM生成あり
 *   node seo/x0099-long-query-to-answer.mjs --input seo/Queries.csv --top 20 --output x0099-report.md
 *
 *   # モックモード（LLM呼び出しなし）
 *   node seo/x0099-long-query-to-answer.mjs --input seo/data/sample-queries.csv --mock
 *
 *   # Search Console API 直接取得（SA鍵が必要）
 *   node seo/x0099-long-query-to-answer.mjs --site "https://www.orgiast.jp/" --api
 *
 * 入力ファイル形式:
 *   CSV (export-search-console.mjs 出力): query, clicks, impressions, ctr, position
 *   JSON: [{ query, clicks, impressions, ctr, position, page? }]
 *
 * 出力:
 *   コンソールに Markdown レポート（--output でファイル保存も可）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from '../tools/is-entry.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const TOOLS_DIR = path.resolve(__dirname, '..', 'tools');
const LLM_ASK = path.join(TOOLS_DIR, 'llm-ask.mjs');

// ─── 長文クエリ判定基準 ───

/**
 * クエリが「長文」か判定する。
 * - 空白区切り語数 >= 10（英字主体）
 * - あるいは空白区切り語数 >= 4（日本語想定）
 * - あるいは Unicode 文字数 >= 20
 * - 除外: site:, inurl:, 英数字羅列 (16文字以上), UUID 様, 記号過多, filetype: 等
 */
function isLongQuery(query) {
  if (!query || typeof query !== 'string') return false;

  // 除外パターン
  if (/^site:|^inurl:|^filetype:|^intitle:|^allintitle:/i.test(query)) return false;
  if (/^[a-zA-Z0-9_-]{16,}$/.test(query)) return false; // 英数字羅列
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(query)) return false; // UUID
  if ((query.match(/[!@#$%^&*+=<>?/\\|~`]/g) || []).length > 5) return false; // 記号過多

  const words = query.trim().split(/\s+/).filter(w => w.length > 0);
  const charLen = [...query].length;

  // 除外: 見た目は長いが実質英数記号のみ
  const alnumRatio = (query.match(/[a-zA-Z0-9]/g) || []).length / query.length;
  if (alnumRatio > 0.8 && charLen >= 16 && words.length < 3) return false;

  // 採用条件
  if (words.length >= 10) return true;
  if (words.length >= 4) return true;
  if (charLen >= 20) return true;

  return false;
}

/**
 * クエリが収益（ブース/サービス）ページ向けかを簡易判定
 */
function isRevenueIntent(query) {
  const revenueKeywords = [
    '費用', '価格', '料金', '予算', '見積', 'コスト', '納期', '期間',
    '工期', 'スケジュール', '比較', '選び方', 'ランキング', 'おすすめ',
    '代金', '支払い', '格安', '安い', '高い', '相場',
  ];
  const lower = query.toLowerCase();
  return revenueKeywords.some(kw => lower.includes(kw));
}

// ─── GSC データ読み込み ───

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = lines[i].split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    const row = {};
    headers.forEach((h, idx) => { row[h] = vals[idx]; });
    rows.push(row);
  }
  return rows;
}

function parseJSON(text) {
  return JSON.parse(text);
}

function loadInput(filePath) {
  const text = fs.readFileSync(filePath, 'utf-8');
  if (filePath.endsWith('.json')) {
    return parseJSON(text);
  }
  return parseCSV(text);
}

/**
 * CSV/JSON の行を統一 format に正規化
 */
function normalizeRow(row) {
  return {
    query: row.query || row.Query || row.クエリ || '',
    clicks: Number(row.clicks || row.Clicks || row.クリック || 0),
    impressions: Number(row.impressions || row.Impressions || row.表示回数 || row.impression || 0),
    ctr: Number(row.ctr || row.CTR || row.Ctr || row.ctrRate || 0),
    position: Number(row.position || row.Position || row.平均順位 || row.pos || 0),
    page: row.page || row.Page || row.PageURL || row.着地URL || row.url || '',
  };
}

// ─── robots.txt 取得 ───

async function fetchRobotsTxt(siteUrl) {
  try {
    const url = new URL('/robots.txt', siteUrl);
    const response = await fetch(url.toString(), { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return { url: url.toString(), status: response.status, body: '' };
    const body = await response.text();
    return { url: url.toString(), status: response.status, body };
  } catch (e) {
    return { url: `${siteUrl}/robots.txt`, error: e.message, body: '' };
  }
}

function checkAIBotBlocking(robotsBody) {
  const bots = ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended', 'CCBot', 'anthropic-ai'];
  const results = {};
  for (const bot of bots) {
    const re = new RegExp(`User-agent:\\s*${bot}\\s*\\n(?:Allow|Disallow):\\s*(\\S+)`, 'mi');
    const match = robotsBody.match(re);
    if (match) {
      results[bot] = match[0].includes('Disallow') ? `Disallow: ${match[1]}` : 'Allow';
    } else {
      results[bot] = '未記載（User-agent: * に従う）';
    }
  }
  return results;
}

// ─── LLM 呼び出し ───

function callLLM(prompt, { mock = false } = {}) {
  if (mock) return '[]';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'x0099-'));
  const promptFile = path.join(tmpDir, 'prompt.txt');
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  try {
    const result = execFileSync(process.execPath, [
      LLM_ASK,
      '--provider', 'openrouter',
      '--model', 'openai/gpt-oss-120b',
      '--prompt-file', promptFile,
      '--max', '16384',
      '--category', 'summarize',
    ], {
      encoding: 'utf-8',
      maxBuffer: 2_000_000,
    });
    return typeof result === 'string' ? result : String(result);
  } finally {
    try { fs.unlinkSync(promptFile); } catch { /* best effort */ }
    try { fs.rmdirSync(tmpDir); } catch { /* best effort */ }
  }
}

// ─── LLM 生成: 見出し＋即答 ───

function buildGeneratePrompt(queries, siteName) {
  const queryList = queries.map((q, i) =>
    `${i + 1}. query: "${q.query}" | page: "${q.page}" | impressions: ${q.impressions} | position: ${q.position} | clicks: ${q.clicks}`
  ).join('\n');

  return `あなたはSEOコンテンツディレクターです。Search Consoleの長文クエリに対し、検索意図に合った見出し案と2〜4文の即答案を生成してください。

対象サイト: ${siteName}

## ルール
1. 各クエリに対し、自然な質問文の形の見出しを1つ考える（例: 「展示会ブースの制作費用はいくらですか？」）
2. 直下に2〜4文の即答案：ユーザーの疑問に直接答え、結論を先に書く
3. 収益意図（費用・価格・納期・比較など）を含むクエリには、価格相場・期間・要件・代替案・比較の情報を即答案に含める
4. 数値は「要確認」「未公開」と書き、捏造しない
5. 回答は日本語。各クエリの出力形式は以下のJSON配列:
[
  {
    "query": "元のクエリ",
    "heading": "質問文の形の見出し",
    "answer": "2〜4文の即答（収益意図があれば価格・期間・要件・代替・比較を含む）",
    "source": "参考にしたページURLまたは「要確認」"
  }
]

## 対象クエリ（上位）
${queryList}

## 注意
- 実際の価格データがない場合は「要確認」と明記すること
- 推測や捏造は禁止
- 各クエリの見出しは異なる質問文にすること（重複しない）`;
}

// ─── LLM 生成: 収益ページ用小見出し ───

function buildRevenueSectionPrompt(page, queries) {
  const queryList = queries.map(q => `- "${q.query}" (impressions: ${q.impressions}, position: ${q.position})`).join('\n');

  return `あなたはSEOコンテンツディレクターです。以下のページが収益に関わるクエリで見つかっています。
このページに対して、次の5つの小見出しを考えてください：

1. 価格: 金額相場・費用内訳
2. 時期: 納期・施工期間・スケジュール
3. 要件: 必要な条件・会場制約
4. 代替: 別の選択肢・工法
5. 比較: 他社・他サービスとの比較観点

ページURL: ${page}
関連クエリ:
${queryList}

出力は以下JSON形式:
{
  "page": "${page}",
  "subheadings": {
    "価格": "見出し文と1〜2文の説明",
    "時期": "見出し文と1〜2文の説明",
    "要件": "見出し文と1〜2文の説明",
    "代替": "見出し文と1〜2文の説明",
    "比較": "見出し文と1〜2文の説明"
  },
  "revenueIntent": true
}

価格・日数は実際の出典がない限り「要確認」と明記し、捏造しないでください。`;
}

// ─── モック応答 ───

function mockGenerateResponses(queries) {
  return queries.map(q => ({
    query: q.query,
    heading: `「${q.query}」に関する情報は？`,
    answer: `こちらは「${q.query}」についてのページです。詳細は元のページをご確認ください。（モック応答）`,
    source: q.page || '要確認',
  }));
}

function mockRevenueSection(page, queries) {
  return {
    page,
    subheadings: {
      '価格': '価格について（要確認）',
      '時期': '時期・納期について（要確認）',
      '要件': '必要な条件について',
      '代替': '代替案について',
      '比較': '比較検討のポイント',
    },
    revenueIntent: queries.some(q => isRevenueIntent(q.query)),
  };
}

// ─── メイン ───

async function main() {
  const args = process.argv.slice(2);

  function opt(name, def) {
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : def;
  }
  function flag(name) { return args.includes(name); }

  const inputFile = opt('--input', '');
  const siteUrl = opt('--site', 'https://www.orgiast.jp/');
  const topN = parseInt(opt('--top', '20'), 10);
  const outputFile = opt('--output', '');
  const isMock = flag('--mock');
  const useApi = flag('--api');
  const minImpressions = parseInt(opt('--min-impressions', '0'), 10);
  const help = flag('--help');

  if (help) {
    console.log(`
X-0099 長文クエリ → 見出し＋即答ツール

使い方:
  node seo/x0099-long-query-to-answer.mjs --input <CSV/JSON> [options]

Options:
  --input <path>         GSCデータファイル（CSV or JSON）
  --site <url>           対象サイトURL（robots.txt取得用、デフォルト: https://www.orgiast.jp/）
  --top <N>              上位N件を処理（デフォルト: 20）
  --output <path>        結果をファイルに保存
  --mock                 LLM呼び出しなし
  --api                  Search Console APIを直接呼び出す（SA鍵必須）
  --min-impressions <N>  最小表示回数フィルタ（デフォルト: 0）
  --help                 このヘルプを表示
`);
    process.exit(0);
  }

  // 1. データ読み込み
  let allRows = [];
  if (inputFile) {
    allRows = loadInput(inputFile).map(normalizeRow);
  } else if (useApi) {
    console.error('[ERROR] --api モードには Search Console の認証設定が必要です。--input でファイルを指定するか、認証を設定してください。');
    process.exit(1);
  } else {
    console.error('[ERROR] --input または --api が必要です。');
    process.exit(1);
  }

  // 2. 長文フィルタ
  const longRows = allRows.filter(r => r.query && isLongQuery(r.query));
  const excludedCount = allRows.filter(r => r.query && !isLongQuery(r.query)).length;

  // 3. 表示回数フィルタ
  const filtered = minImpressions > 0
    ? longRows.filter(r => r.impressions >= minImpressions)
    : longRows;

  // 4. 表示回数降順ソート
  const sorted = [...filtered].sort((a, b) => b.impressions - a.impressions);

  // 5. 収益意図の判定
  const revenueQueries = sorted.filter(r => isRevenueIntent(r.query));
  const topQueries = sorted.slice(0, topN);
  const topRevenueQueries = revenueQueries.filter(r => topQueries.includes(r));

  // 6. robots.txt 取得
  const robots = await fetchRobotsTxt(siteUrl);
  const botCheck = checkAIBotBlocking(robots.body);

  // 7. LLM生成（またはモック）
  let headingAnswers = [];
  let revenueSections = [];

  if (isMock) {
    headingAnswers = mockGenerateResponses(topQueries);
    // 収益ページグループ化（ページごとに）
    const pageGroups = {};
    for (const q of topRevenueQueries) {
      const page = q.page || '(no page)';
      if (!pageGroups[page]) pageGroups[page] = [];
      pageGroups[page].push(q);
    }
    revenueSections = Object.entries(pageGroups).map(([page, qs]) =>
      mockRevenueSection(page, qs)
    );
  } else {
    // 見出し＋即答 生成
    const genPrompt = buildGeneratePrompt(topQueries, siteUrl);
    const genRaw = callLLM(genPrompt, { mock: false });
    try {
      const jsonMatch = genRaw.match(/\[\s*\{[\s\S]*\}\s*\]/);
      if (jsonMatch) {
        headingAnswers = JSON.parse(jsonMatch[0]);
      } else {
        console.error('[WARN] LLM応答からJSONを抽出できませんでした。生データ:', genRaw.slice(0, 200));
      }
    } catch (e) {
      console.error('[WARN] LLM応答のパース失敗:', e.message);
      headingAnswers = mockGenerateResponses(topQueries);
    }

    // 収益ページ用小見出し生成
    const pageGroups = {};
    for (const q of topRevenueQueries) {
      const page = q.page || '(no page)';
      if (!pageGroups[page]) pageGroups[page] = [];
      pageGroups[page].push(q);
    }
    for (const [page, qs] of Object.entries(pageGroups)) {
      const revPrompt = buildRevenueSectionPrompt(page, qs);
      const revRaw = callLLM(revPrompt, { mock: false });
      try {
        const jsonMatch = revRaw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          revenueSections.push(JSON.parse(jsonMatch[0]));
        }
      } catch (e) {
        console.error('[WARN] 収益セクションLLM応答のパース失敗:', e.message);
        revenueSections.push(mockRevenueSection(page, qs));
      }
    }
  }

  // 8. レポート生成
  const siteName = siteUrl.replace(/https?:\/\//, '').replace(/\/$/, '');
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const uniqueQueries = new Set(longRows.map(r => r.query)).size;

  let report = `# X-0099 長文クエリ分析レポート（${dateStr}）

対象サイト: ${siteUrl}
期間: 直近90日（GSCデータ）

## データ概要

| 指標 | 値 |
|---|---:|
| 取得総行数 | ${allRows.length} |
| 長文該当行 | ${longRows.length} |
| 長文ユニーククエリ | ${uniqueQueries} |
| 非長文行（除外） | ${excludedCount} |
| 収益意図クエリ（長文内） | ${revenueQueries.length} |
| 分析対象（上位${topN}） | ${topQueries.length}件 |

## 長文クエリ 表示回数上位${topQueries.length}

| # | クエリ | 着地URL | 平均順位 | クリック | 表示 | 収益意図 |
|---:|---|---:|---:|---:|---:|:---:|
`;

  topQueries.forEach((q, i) => {
    report += `| ${i + 1} | ${q.query} | ${q.page || '-'} | ${q.position.toFixed(1)} | ${q.clicks} | ${q.impressions} | ${isRevenueIntent(q.query) ? '💰' : ''} |\n`;
  });

  report += `\n## 見出し案＋即答案（上位${headingAnswers.length}）\n\n`;

  headingAnswers.forEach((ha, i) => {
    report += `### ${i + 1}. ${ha.query}\n`;
    report += `- **見出し案**: ${ha.heading || '(生成できませんでした)'}\n`;
    report += `- **即答案**: ${ha.answer || '(生成できませんでした)'}\n`;
    report += `- **出典**: ${ha.source || '要確認'}\n\n`;
  });

  if (revenueSections.length > 0) {
    report += `## 収益ページ 小見出し構成案（価格・時期・要件・代替・比較）\n\n`;
    for (const rs of revenueSections) {
      report += `### ${rs.page}\n`;
      if (rs.subheadings) {
        for (const [key, val] of Object.entries(rs.subheadings)) {
          report += `1. **${key}**: ${val}\n`;
        }
      }
      report += '\n';
    }
  }

  report += `## robots.txt（AIクローラ扱い）\n\n`;
  report += `取得日: ${dateStr} | 取得元: ${robots.url}\n\n`;
  if (robots.error) {
    report += `⚠️ robots.txt 取得エラー: ${robots.error}\n\n`;
  } else {
    report += `| Bot | 状態 |\n|---|---|\n`;
    for (const [bot, status] of Object.entries(botCheck)) {
      report += `| ${bot} | ${status} |\n`;
    }
    report += '\n';
  }

  report += `---\n\n`;
  report += `生成: X-0099 Long Query to Answer Tool | ${dateStr}\n`;

  // 9. 出力
  if (outputFile) {
    const outPath = path.resolve(outputFile);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, report, 'utf-8');
    console.log(`[OK] レポートを保存しました: ${outPath}`);
  }

  console.log(report);
}

// ─── エントリーポイント ───

if (isEntry(import.meta.url)) {
  main().catch(e => {
    console.error('[ERROR]', e.message);
    process.exit(1);
  });
}