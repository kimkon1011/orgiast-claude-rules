#!/usr/bin/env node
/**
 * ai-mention-checker.mjs — AI回答言及チェッカー
 *
 * X-0011: SEOとAEOの11の再現可能手法（手法9）
 * ChatGPT / Claude / Gemini / Perplexity 等に「おすすめ展示会ブース制作会社」と尋ね、
 * 株式会社オージャストが言及されているかを確認する。
 *
 * 使い方:
 *   node tools/ai-mention-checker.mjs [--query "質問文"] [--providers gemini,deepseek] [--output json|markdown]
 *   node tools/ai-mention-checker.mjs --monthly    # 月次レポートモード
 *
 * 依存: tools/llm-ask.mjs（Gemini・DeepSeek等）
 */

import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

const DEFAULTS = {
  query: '展示会ブース制��会社でおすすめを教えてください。大阪の会社を中心に、実績のある会社をいくつか挙げてください。',
  providers: ['gemini', 'deepseek'],  // llm-ask.mjs 経由で呼べるプロバイダ
  output: 'markdown',
};

// オージャストを示すキーワードパターン
export const ORGIEST_PATTERNS = [
  /オージャスト/i,
  /orgiast/i,
  /オーシャスト/i,  // 誤表記
];

// ===== LLM呼び出し =====
function queryProvider(provider, query) {
  const llmAskPath = resolve(REPO_ROOT, 'tools', 'llm-ask.mjs');
  if (!existsSync(llmAskPath)) {
    return { provider, error: 'llm-ask.mjs が見つかりません', mentioned: false, response: '' };
  }

  try {
    const result = execSync(
      `node "${llmAskPath}" --provider ${provider} --prompt "${query.replace(/"/g, '\\"')}" --kind investigate --cwd "${REPO_ROOT}"`,
      { encoding: 'utf8', timeout: 60000, windowsHide: true, maxBuffer: 1024 * 1024 }
    );
    const response = result.trim();
    const mentioned = ORGIEST_PATTERNS.some(p => p.test(response));
    return { provider, response, mentioned, error: null };
  } catch (e) {
    return { provider, error: e.message, mentioned: false, response: '' };
  }
}

// ===== 結果分析 =====
export function analyzeResponse(provider, response) {
  const mentioned = ORGIEST_PATTERNS.some(p => p.test(response));

  // 言及されている場合、前後の文脈を抽出
  let context = null;
  if (mentioned) {
    for (const pattern of ORGIEST_PATTERNS) {
      const match = response.match(pattern);
      if (match) {
        const idx = match.index;
        const start = Math.max(0, idx - 80);
        const end = Math.min(response.length, idx + 80);
        context = response.slice(start, end).replace(/\n/g, ' ');
        break;
      }
    }
  }

  // 競合他社の言及を検出
  const competitors = [];
  const COMPETITOR_PATTERNS = [
    /野村興産/i, /ノムラコーサン/i,
    /サクラインターナショナル/i,
    /ワールド/i,
    /ナニワ/i,
    /大和ハウス/i,
  ];
  for (const pattern of COMPETITOR_PATTERNS) {
    const matches = response.match(pattern);
    if (matches) competitors.push(matches[0]);
  }

  return { mentioned, context, competitors };
}

// ===== レポート生成 =====
function formatMarkdown(results, query) {
  const mentionedCount = results.filter(r => r.mentioned).length;
  const totalSuccess = results.filter(r => !r.error).length;
  const lines = [
    `# AI回答言及チェックレポート`,
    ``,
    `| 項目 | 値 |`,
    `|------|-----|`,
    `| 調査日 | ${new Date().toISOString().split('T')[0]} |`,
    `| 質問 | ${query} |`,
    `| 調査プロバイダ数 | ${results.length} |`,
    `| 成功 | ${totalSuccess} |`,
    `| オージャスト言及 | ${mentionedCount}/${totalSuccess} (${totalSuccess > 0 ? Math.round(mentionedCount / totalSuccess * 100) : 0}%) |`,
    ``,
  ];

  if (totalSuccess === 0) {
    lines.push('## ⚠ 注意');
    lines.push('');
    lines.push('全てのプロバイダでエラーが発生しました。APIキーまたは llm-ask.mjs の設定を確認してください。');
    lines.push('');
    lines.push('### エラー詳細');
    results.forEach(r => {
      lines.push(`- **${r.provider}**: ${r.error}`);
    });
    return lines.join('\n');
  }

  lines.push('## 📊 プロバイダ別結果');
  lines.push('');

  for (const r of results) {
    const status = r.error ? '❌ エラー' : (r.mentioned ? '✅ 言及あり' : '⚠ 言及なし');
    lines.push(`### ${r.provider} — ${status}`);
    lines.push('');

    if (r.error) {
      lines.push(`エラー: ${r.error}`);
    } else {
      const analysis = analyzeResponse(r.provider, r.response);
      lines.push(`**言及**: ${analysis.mentioned ? '✅ あり' : '❌ なし'}`);
      if (analysis.context) {
        lines.push(`**文脈**: "${analysis.context}"`);
      }
      if (analysis.competitors.length > 0) {
        lines.push(`**検出された競合**: ${[...new Set(analysis.competitors)].join('、')}`);
      }
      lines.push('');
      lines.push('```');
      lines.push(r.response.slice(0, 1000));
      if (r.response.length > 1000) lines.push('...（省略）');
      lines.push('```');
    }
    lines.push('');
  }

  // サマリ
  lines.push('## 📈 サマリ');
  lines.push('');
  if (mentionedCount === 0 && totalSuccess > 0) {
    lines.push('**⚠ 現在、AI検索結果にオージャストの言及は確認できませんでした。**');
    lines.push('');
    lines.push('### 改善アクション');
    lines.push('1. orgiast.jp の構造化データ（JSON-LD）を強化する');
    lines.push('2. 展示会ブース関連の専門用語をサイト内で網羅的にカバーする');
    lines.push('3. 外部サイトからの引用・被リンクを増やす');
    lines.push('4. Google Business Profile を最新情報に更新する');
    lines.push('5. 展示会業界の権威あるサイトからの被リンクを獲得する');
  } else if (mentionedCount > 0) {
    lines.push(`**✅ ${mentionedCount}件のプロバイダでオージャストの言及を確認しました。**`);
    lines.push('');
    lines.push('### 現状維持のアクション');
    lines.push('1. 言及内容の正確性を確認する');
    lines.push('2. 言及の増減を月次でトラッキングする');
    lines.push('3. 言及がないプロバイダへの対策を優先する');
  }

  return lines.join('\n');
}

// ===== CLI =====
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { ...DEFAULTS };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--query': opts.query = args[++i]; break;
      case '--providers': opts.providers = args[++i].split(','); break;
      case '--output': opts.output = args[++i]; break;
      case '--monthly': opts.monthlyMode = true; break;
      case '--save-dir': opts.saveDir = args[++i]; break;
      case '--help':
        console.log(`使い方: ai-mention-checker.mjs [options]
  --query <text>       質問文 (default: "${DEFAULTS.query.slice(0, 40)}...")
  --providers <list>   プロバイダ (comma-separated, default: ${DEFAULTS.providers.join(',')})
  --output <format>    出力形式 (json|markdown, default: ${DEFAULTS.output})
  --monthly            月次レポートモード（日付付きで保存）
  --save-dir <path>    保存先ディレクトリ (default: outputs/X-0011/mentions/)
  --help               このヘルプ`);
        process.exit(0);
    }
  }

  return opts;
}

// ===== メイン =====
async function main() {
  const opts = parseArgs();
  const saveDir = opts.saveDir || resolve(REPO_ROOT, 'outputs', 'X-0011', 'mentions');

  console.error('='.repeat(50));
  console.error('🤖 AI回答言及チェック');
  console.error(`   質問: ${opts.query.slice(0, 60)}...`);
  console.error(`   プロバイダ: ${opts.providers.join(', ')}`);
  console.error('='.repeat(50));

  // 各プロバイダに問い合わせ
  const results = [];
  for (const provider of opts.providers) {
    console.error(`\n📡 ${provider} に問い合わせ中...`);
    const result = queryProvider(provider, opts.query);
    results.push(result);
    if (result.error) {
      console.error(`   ❌ エラー: ${result.error}`);
    } else {
      const analysis = analyzeResponse(provider, result.response);
      console.error(`   ${analysis.mentioned ? '✅ 言及あり' : '⚠ 言及なし'}`);
    }
  }

  // 出力
  const output = opts.output === 'json'
    ? JSON.stringify({
        date: new Date().toISOString(),
        query: opts.query,
        results,
      }, null, 2)
    : formatMarkdown(results, opts.query);

  if (opts.output === 'json') {
    console.log(output);
  } else {
    console.log('\n' + output);
  }

  // 保存（月次モード）
  if (opts.monthlyMode) {
    mkdirSync(saveDir, { recursive: true });
    const dateStr = new Date().toISOString().split('T')[0];
    const ext = opts.output === 'json' ? 'json' : 'md';
    const savePath = resolve(saveDir, `mention-check-${dateStr}.${ext}`);
    writeFileSync(savePath, output, 'utf8');
    console.error(`\n💾 保存: ${savePath}`);
  }

  // サマリ
  const mentioned = results.filter(r => !r.error && analyzeResponse(r.provider, r.response).mentioned).length;
  const success = results.filter(r => !r.error).length;
  console.error(`\n✅ 完了: ${mentioned}/${success} プロバイダで言及確認`);
}

if (isEntry(import.meta.url)) {
main().catch(err => {
  console.error('❌ 致命的エラー:', err.message);
  process.exit(1);
});
}
