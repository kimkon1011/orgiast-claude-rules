#!/usr/bin/env node
/**
 * competitive-gap-analyzer.mjs — 競合キーワードギャップ分析 + AI優先順位付け
 *
 * Ahrefs Content Gap の競合キーワードCSVとGSCの自社クエリデータをAIで分析し、
 * 「競合1-5位、自社6-20位」のキーワードを抽出・意図分類・優先順位付けする。
 *
 * X-0010: 競合キーワード差分をAIで優先順位付け
 *
 * 使い方:
 *   node tools/competitive-gap-analyzer.mjs \
 *     --competitor-csv data/competitor-keywords.csv \
 *     --gsc-json data/gsc-queries.json \
 *     --output markdown
 *
 *   node tools/competitive-gap-analyzer.mjs \
 *     --competitor-csv data/competitor-keywords.csv \
 *     --gsc-csv data/gsc-queries.csv \
 *     --output json
 *
 * 依存:
 *   tools/llm-ask.mjs (LLM分類に使用)
 *   npm: csv-parse/sync
 */

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ===== 設定 =====
const DEFAULTS = {
  output: 'markdown',
  limit: 20,
  llmProvider: '', // 空の場合はllm-askのデフォルト
  siteUrl: 'https://www.orgiast.jp',
};

// ===== CSV解析（簡易版 / 依存回避） =====
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line) => {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++; }
        else { inQuotes = !inQuotes; }
      } else if (ch === ',' && !inQuotes) {
        result.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = parseLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = vals[i] || ''; });
    return row;
  });

  return { headers, rows };
}

// ===== GSC JSON読み込み =====
function loadGscJson(filePath) {
  const data = JSON.parse(readFileSync(filePath, 'utf8'));
  const candidates = data.candidates || data.rows || data;
  if (!Array.isArray(candidates)) {
    throw new Error('GSC JSONの形式が不明です。{candidates:[...]} または配列が必要です。');
  }
  return candidates.map(c => ({
    keyword: c.keyword || c.keys?.[0] || c.query || '',
    impressions: c.impressions || 0,
    clicks: c.clicks || 0,
    ctr: c.ctr || 0,
    position: c.position || 999,
  }));
}

// ===== GSC CSV読み込み =====
function loadGscCsv(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const { rows } = parseCSV(text);
  return rows.map(r => ({
    keyword: (r.Query || r.query || r.Keyword || r.keys || '').trim(),
    impressions: parseInt(r.Impressions || r.impressions || 0),
    clicks: parseInt(r.Clicks || r.clicks || 0),
    ctr: parseFloat(r.CTR || r.ctr || 0),
    position: parseFloat(r.Position || r.position || 999),
  })).filter(r => r.keyword);
}

// ===== 競合CSV読み込み =====
function loadCompetitorCsv(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const { headers, rows } = parseCSV(text);

  return rows.map(r => {
    const keyword = (r.Keyword || r.keyword || '').trim();
    const volume = parseInt(r.Volume || r.volume || '0');
    const difficulty = parseInt(r.KD || r.kd || r.Difficulty || r.difficulty || '0');

    // 競合ポジション列を収集
    const competitorPositions = {};
    for (const [key, val] of Object.entries(r)) {
      if (/position|pos|rank|順位/i.test(key) && val) {
        competitorPositions[key] = parseFloat(val);
      }
    }

    return { keyword, volume, difficulty, competitorPositions, raw: r };
  }).filter(r => r.keyword);
}

// ===== AI分析LLMプロンプト構築 =====
function buildGapAnalysisPrompt(competitors, ownQueries) {
  const competitorSummary = competitors.slice(0, 50).map(c => {
    const posStr = Object.entries(c.competitorPositions)
      .map(([k, v]) => `${k}:${v}`).join(', ');
    return `"${c.keyword}" (volume:${c.volume}, difficulty:${c.difficulty}, positions: {${posStr}})`;
  }).join('\n');

  const ownSummary = ownQueries.slice(0, 50).map(q =>
    `"${q.keyword}" (impressions:${q.impressions}, ctr:${(q.ctr * 100).toFixed(1)}%, position:${q.position})`
  ).join('\n');

  const totalCompetitor = competitors.length;
  const totalOwn = ownQueries.length;

  return `あなたはSEOアナリストです。以下の競合キーワードデータと自社GSCデータを分析し、「競合が上位（1-5位）で自社が6-20位」のキーワードを抽出し、検索意図と優先度を評価してください。

## ルール
- 競合キーワードのポジションが1-5位かつ自社の順位が6-20位のキーワードのみを抽出
- 両方のデータに存在するキーワードだけが分析対象
- 各キーワードに優先度スコアを計算（0-100）

## 意図分類定義
- 情報収集: 「とは」「やり方」「費用」「料金」「方法」などの情報探索キーワード
- 比較検討: 「比較」「おすすめ」「ランキング」「口コミ」「評判」「違い」
- 商談・発注: 「見積」「依頼」「申込」「会社」「業者」「制作会社」「施工」
- 事例参照: 「事例」「実績」「施工例」「導入事例」「参考」

## 優先度スコア計算式
priority_score = (ギャップ幅 × 10) + ボリューム補正 + 未カバー補正 + 意図補正
- ギャップ幅: 自社順位 - 競合平均順位（最大5点）
- ボリューム補正(impressions): >5000→20, >1000→15, >500→10, >100→5
- 未カバー補正: 自社に適切なページがない→20（6-20位なら通常の補正値: 10）
- 意図補正: 商談・発注→25, 比較検討→15, 情報収集→5, 事例参照→10

## 競合キーワードデータ（全${totalCompetitor}件から上位50件抜粋）
${competitorSummary}

## 自社GSCクエリデータ（全${totalOwn}件から上位50件抜粋）
${ownSummary}

## 出力形式
以下のJSON配列形式で出力。キーワードのみ、説明や注釈は含めないこと。
[
  {
    "keyword": "展示会ブース デザイン",
    "competitor_avg_position": 2.3,
    "own_position": 8,
    "gap": 5.7,
    "search_intent": "比較検討",
    "search_volume": 1200,
    "difficulty": 45,
    "priority_score": 85,
    "recommended_action": "現状ページの改善＋CTA追加"
  }
]

出力は有効なJSON配列のみ。ランク外や他の話を含めない。該当なしの場合は空配列[]。`;
}

// ===== AI分析呼び出し =====
function runLlmAnalysis(prompt, provider) {
  const llmAskPath = resolve(__dirname, 'llm-ask.mjs');
  if (!existsSync(llmAskPath)) {
    throw new Error(`llm-ask.mjs が見つかりません: ${llmAskPath}`);
  }

  const args = ['--kind', 'classify', '--max', '8000'];
  if (provider) args.push('--provider', provider);

  const result = spawnSync('node', [llmAskPath, ...args], {
    input: prompt,
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
    timeout: 120000,
  });

  if (result.error) {
    throw new Error(`LLM分析の実行に失敗: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`LLM分析が異常終了(code=${result.status}): ${result.stderr?.slice(0, 500)}`);
  }

  const stdout = result.stdout?.trim() || '';
  const stderr = result.stderr?.trim() || '';

  // JSONをstdoutから抽出（llm-askはstderrにログを出力し、stdoutにJSONを出力する）
  const jsonMatch = stdout.match(/\[[\s\S]*\]/);
  if (jsonMatch) {
    try {
      return { data: JSON.parse(jsonMatch[0]), stderr };
    } catch (e) {
      throw new Error(`LLM応答のJSONパース失敗: ${e.message}\n応答抜粋: ${stdout.slice(0, 300)}`);
    }
  }

  // stderrにもJSONが含まれる場合
  const stderrJsonMatch = stderr.match(/\[[\s\S]*\]/);
  if (stderrJsonMatch) {
    try {
      return { data: JSON.parse(stderrJsonMatch[0]), stderr };
    } catch (e) {
      throw new Error(`LLM応答(stderr)のJSONパース失敗: ${e.message}`);
    }
  }

  throw new Error(`LLMから有効なJSON応答が得られませんでした\nstdout: ${stdout.slice(0, 500)}\nstderr: ${stderr.slice(0, 500)}`);
}

// ===== フォーマッター =====
function formatMarkdown(gaps, options) {
  if (gaps.length === 0) {
    return '# 競合キーワードギャップ分析\n\n該当するキーワードギャップは見つかりませんでした。';
  }

  // 優先度スコア順にソート
  const sorted = [...gaps].sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0));

  const lines = [
    '# 競合キーワードギャップ分析レポート',
    '',
    `| 調査日 | ${new Date().toISOString().split('T')[0]} |`,
    `|--------|------|`,
    `| 対象サイト | ${options.siteUrl} |`,
    `| 抽出条件 | 競合1-5位 ∩ 自社6-20位 |`,
    `| 該当ギャップ数 | ${gaps.length}件 |`,
    '',
    '## 優先順位付きギャップキーワード',
    '',
    '| # | キーワード | 競合平均 | 自社 | 差 | 意図分類 | 検索ボリューム | 難易度 | 優先度 | 推奨アクション |',
    '|---|-----------|--------:|----:|---:|---------|-------------:|------:|------:|--------------|',
  ];

  sorted.slice(0, options.limit).forEach((g, i) => {
    lines.push(
      `| ${i + 1} | ${g.keyword} | ${(g.competitor_avg_position || 0).toFixed(1)}位 | ${(g.own_position || 0).toFixed(1)}位 | ${(g.gap || 0).toFixed(1)} | ${g.search_intent || '—'} | ${(g.search_volume || 0).toLocaleString()} | ${g.difficulty || '—'} | ${g.priority_score || 0} | ${g.recommended_action || '—'} |`
    );
  });

  // 意図別サマリ
  const intentCounts = {};
  for (const g of gaps) {
    const intent = g.search_intent || '未分類';
    intentCounts[intent] = (intentCounts[intent] || 0) + 1;
  }

  lines.push('');
  lines.push('## 検索意図別分布');
  lines.push('');
  lines.push('| 意図 | 件数 | 割合 |');
  lines.push('|------|-----:|-----:|');
  const total = gaps.length;
  for (const [intent, count] of Object.entries(intentCounts).sort((a, b) => b[1] - a[1])) {
    const pct = ((count / total) * 100).toFixed(1);
    lines.push(`| ${intent} | ${count}件 | ${pct}% |`);
  }

  // 改善アクションサマリ
  lines.push('');
  lines.push('## 推奨アクション');
  lines.push('');

  const actionGroups = {
    '新規ページ作成': gaps.filter(g => /新規|作成|作る/.test(g.recommended_action || '')),
    'ページ改善': gaps.filter(g => /改善|更新|リライト/.test(g.recommended_action || '')),
    'CTA・リンク改善': gaps.filter(g => /CTA|リンク|内部/.test(g.recommended_action || '')),
    'その他': [],
  };

  for (const [action, items] of Object.entries(actionGroups)) {
    if (items.length > 0) {
      lines.push(`### ${action}（${items.length}件）`);
      lines.push('');
      items.slice(0, 5).forEach(g => {
        lines.push(`- **${g.keyword}**（優先度:${g.priority_score}）: ${g.recommended_action}`);
      });
      if (items.length > 5) lines.push(`  ...ほか${items.length - 5}件`);
      lines.push('');
    }
  }

  return lines.join('\n');
}

function formatCsv(gaps) {
  const sorted = [...gaps].sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0));
  const header = 'keyword,competitor_avg_position,own_position,gap,search_intent,search_volume,difficulty,priority_score,recommended_action';
  const rows = sorted.map(g =>
    `"${g.keyword}","${g.competitor_avg_position || ''}","${g.own_position || ''}","${g.gap || ''}","${g.search_intent || ''}","${g.search_volume || ''}","${g.difficulty || ''}","${g.priority_score || ''}","${(g.recommended_action || '').replace(/"/g, '""')}"`
  );
  return [header, ...rows].join('\n');
}

// ===== CLI引数解析 =====
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { ...DEFAULTS };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--competitor-csv': opts.competitorCsv = args[++i]; break;
      case '--gsc-json': opts.gscJson = args[++i]; break;
      case '--gsc-csv': opts.gscCsv = args[++i]; break;
      case '--output': opts.output = args[++i]; break;
      case '--limit': opts.limit = parseInt(args[++i]); break;
      case '--site': opts.siteUrl = args[++i]; break;
      case '--llm-provider': opts.llmProvider = args[++i]; break;
      case '--report-file': opts.reportFile = args[++i]; break;
      case '--help':
        console.log(`使い方: competitive-gap-analyzer.mjs [options]

必須（どちらか）:
  --competitor-csv <path>  競合キーワードCSV（Ahrefs Content Gap エクスポート）
  --gsc-json <path>        GSCクエリJSON（gsc-keyword-finder.mjs の出力）
  --gsc-csv <path>         GSCクエリCSV（Search Console エクスポート）

オプション:
  --output <format>        出力形式（markdown|json|csv, default: markdown）
  --limit <n>              出力件数（default: 20）
  --site <url>             自社サイトURL（default: https://www.orgiast.jp）
  --llm-provider <name>    LLMプロバイダ指定（gemini/deepseek等）
  --report-file <path>     レポートをファイルに保存
  --help                   このヘルプ`);
        process.exit(0);
    }
  }

  if (!opts.competitorCsv) {
    console.error('--competitor-csv は必須です');
    process.exit(2);
  }
  if (!opts.gscJson && !opts.gscCsv) {
    console.error('--gsc-json または --gsc-csv は必須です');
    process.exit(2);
  }

  return opts;
}

// ===== メイン =====
async function main() {
  const options = parseArgs();

  // ファイル存在確認
  for (const key of ['competitorCsv', 'gscJson', 'gscCsv']) {
    if (options[key] && !existsSync(options[key])) {
      console.error(`❌ ファイルが見つかりません: ${options[key]}`);
      process.exit(1);
    }
  }

  console.error('🔍 競合キーワードギャップ分析 開始');

  // Step 1: データ読み込み
  console.error('📂 競合キーワード読み込み中...');
  const competitors = loadCompetitorCsv(options.competitorCsv);
  console.error(`   ${competitors.length}件の競合キーワードを読み込み`);

  let ownQueries;
  if (options.gscJson) {
    console.error('📊 GSC JSONデータ読み込み中...');
    ownQueries = loadGscJson(options.gscJson);
  } else {
    console.error('📊 GSC CSVデータ読み込み中...');
    ownQueries = loadGscCsv(options.gscCsv);
  }
  console.error(`   ${ownQueries.length}件の自社クエリを読み込み`);

  // Step 2: AI分析
  console.error('🤖 AIによるギャップ分析中...');
  console.error(`   LLM: ${options.llmProvider || '既定'}`);
  const prompt = buildGapAnalysisPrompt(competitors, ownQueries);
  const analysis = runLlmAnalysis(prompt, options.llmProvider);

  const gaps = analysis.data;
  console.error(`   ${gaps.length}件のギャップキーワードを検出`);

  // Step 3: 出力
  switch (options.output) {
    case 'json':
      const jsonOutput = JSON.stringify({
        generatedAt: new Date().toISOString(),
        siteUrl: options.siteUrl,
        totalGaps: gaps.length,
        gaps: gaps.slice(0, options.limit),
      }, null, 2);
      if (options.reportFile) {
        writeFileSync(options.reportFile, jsonOutput, 'utf8');
        console.error(`💾 JSONレポートを保存: ${options.reportFile}`);
      } else {
        console.log(jsonOutput);
      }
      break;

    case 'csv':
      const csvOutput = formatCsv(gaps);
      if (options.reportFile) {
        writeFileSync(options.reportFile, csvOutput, 'utf8');
        console.error(`💾 CSVレポートを保存: ${options.reportFile}`);
      } else {
        console.log(csvOutput);
      }
      break;

    case 'markdown':
    default:
      const mdOutput = formatMarkdown(gaps, options);
      if (options.reportFile) {
        writeFileSync(options.reportFile, mdOutput, 'utf8');
        console.error(`💾 Markdownレポートを保存: ${options.reportFile}`);
      } else {
        console.log(mdOutput);
      }
      break;
  }

  // LLMの実行ログ（stderr）を表示
  if (analysis.stderr) {
    const logLines = analysis.stderr.split('\n').filter(l =>
      l.includes('[routing]') || l.includes('[cost]') || l.includes('[usage]')
    );
    if (logLines.length > 0) {
      console.error('\n📋 LLM実行ログ:');
      logLines.forEach(l => console.error(`  ${l}`));
    }
  }

  console.error(`\n✅ 完了 (${new Date().toISOString()})`);
}

main().catch(err => {
  console.error('❌ エラー:', err.message);
  process.exit(1);
});
