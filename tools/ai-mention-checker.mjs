/**
 * X-0007: AI検索結果におけるorgiast.jp/オージャストの引用状況を測定する
 *
 * 使い方:
 *   node tools/ai-mention-checker.mjs --query "展示会ブース制作 費用 大阪 おすすめ"
 *   node tools/ai-mention-checker.mjs --query "株式会社オージャストの展示会ブース制作について" --json
 *   node tools/ai-mention-checker.mjs --help
 *
 * APIキー不要（DuckDuckGo Lite を使用）
 */

const HELPTEXT = `ai-mention-checker — AI検索引用測定ツール

使い方:
  node tools/ai-mention-checker.mjs --query <検索クエリ> [オプション]

オプション:
  --query <text>      検索クエリ（必須）
  --provider <name>   AIプロバイダラベル（gemini | groq | deepseek、デフォルト: gemini）
  --json              JSON形式で出力
  --output <file>     Markdownレポートをファイルに出力
  --help              このヘルプを表示

説明:
  検索結果を取得し、orgiast.jp および オージャスト への
  言及をスコアリングします。APIキー不要で動作します。`;

import https from 'node:https';
import { fileURLToPath } from 'node:url';

const PROVIDERS = new Set(['gemini', 'groq', 'deepseek']);

/**
 * CLI引数をパースする
 * @param {string[]} argv
 * @returns {{ help?: boolean, query?: string, provider?: string, json?: boolean, output?: string }}
 */
export function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    switch (argv[i]) {
      case '--help':
        args.help = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--query':
        if (i + 1 < argv.length) {
          args.query = argv[++i];
        }
        break;
      case '--provider':
        if (i + 1 < argv.length) {
          args.provider = argv[++i];
        }
        break;
      case '--output':
        if (i + 1 < argv.length) {
          args.output = argv[++i];
        }
        break;
      default:
        // unknown option, skip
        break;
    }
  }
  return args;
}

/**
 * DuckDuckGo Lite から検索結果のHTMLを取得する
 * @param {string} query
 * @returns {Promise<string>}
 */
export function fetchSearchResults(query) {
  return new Promise((resolve, reject) => {
    const encoded = encodeURIComponent(query);
    const url = `https://lite.duckduckgo.com/lite/?q=${encoded}`;
    const req = https.get(url, { timeout: 15000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        // redirect を追跡
        const followUrl = res.headers.location.startsWith('http')
          ? res.headers.location
          : `https://lite.duckduckgo.com${res.headers.location}`;
        https.get(followUrl, { timeout: 15000 }, (res2) => {
          if (res2.statusCode !== 200) {
            res2.resume();
            reject(new Error(`HTTP ${res2.statusCode}`));
            return;
          }
          let data = '';
          res2.on('data', (chunk) => data += chunk);
          res2.on('end', () => resolve(data));
          res2.on('error', reject);
        }).on('error', reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

/**
 * DuckDuckGo Lite のHTMLから検索結果をパースする
 * @param {string} html
 * @returns {{ title: string, url: string, snippet: string }[]}
 */
export function parseDuckDuckGoResults(html) {
  const results = [];
  // DuckDuckGo Lite の結果は <a rel="nofollow" href="..."> と <a class="result-link" ...> を含む
  // タイトル: <a rel="nofollow" href="URL" class="result-link">TITLE</a>
  // スニペット: <td class="result-snippet">SNIPPET</td>

  const linkRegex = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  let linkMatch;
  const titles = [];
  const urls = [];

  while ((linkMatch = linkRegex.exec(html)) !== null) {
    urls.push(linkMatch[1]);
    titles.push(linkMatch[2].replace(/<[^>]+>/g, '').trim());
  }

  let snippetMatch;
  const snippets = [];
  while ((snippetMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(snippetMatch[1].replace(/<[^>]+>/g, '').trim());
  }

  const count = Math.max(titles.length, urls.length, snippets.length);
  for (let i = 0; i < count; i++) {
    results.push({
      title: titles[i] || '',
      url: urls[i] || '',
      snippet: snippets[i] || '',
    });
  }

  return results;
}

/**
 * 解析結果をスコアリングする
 * @param {{ title: string, url: string, snippet: string }[]} results
 * @returns {{ present: boolean, mentionCount: number, totalResults: number, mentionRate: number, snippets: { title: string, url: string, snippet: string }[] }}
 */
export function analyzeResults(results) {
  const domainPattern = /orgiast\.jp/i;
  const companyPattern = /オージャスト/i;

  const matched = [];

  for (const result of results) {
    const inUrl = domainPattern.test(result.url);
    const inTitle = companyPattern.test(result.title);
    const inSnippet = companyPattern.test(result.snippet);
    if (inUrl || inTitle || inSnippet) {
      matched.push(result);
    }
  }

  return {
    present: matched.length > 0,
    mentionCount: matched.length,
    totalResults: results.length,
    mentionRate: results.length > 0 ? matched.length / results.length : 0,
    snippets: matched.map(r => ({ title: r.title, url: r.url, snippet: r.snippet })),
  };
}

/**
 * スコアからMarkdownレポートを生成する
 * @param {{ present: boolean, mentionCount: number, totalResults: number, mentionRate: number, snippets: { title: string, url: string, snippet: string }[] }} score
 * @param {string} query
 * @param {string} provider
 */
export function formatMarkdown(score, query, provider) {
  const lines = [];
  lines.push(`# AI検索引用レポート`);
  lines.push(``);
  lines.push(`- **クエリ**: \`${query}\``);
  lines.push(`- **プロバイダ**: ${provider}`);
  lines.push(`- **取得日時**: ${new Date().toISOString()}`);
  lines.push(``);
  lines.push(`## スコア`);
  lines.push(``);
  lines.push(`| 指標 | 値 |`);
  lines.push(`|------|-----|`);
  lines.push(`| 言有無 | ${score.present ? '✅ あり' : '❌ なし'} |`);
  lines.push(`| 言及数 | ${score.mentionCount} |`);
  lines.push(`| 全結果数 | ${score.totalResults} |`);
  lines.push(`| 言及率 | ${(score.mentionRate * 100).toFixed(1)}% |`);
  lines.push(``);

  if (score.snippets.length > 0) {
    lines.push(`## 該当結果`);
    lines.push(``);
    for (const s of score.snippets) {
      lines.push(`- **${s.title}**`);
      lines.push(`  - URL: ${s.url}`);
      if (s.snippet) lines.push(`  - スニペット: ${s.snippet}`);
      lines.push(``);
    }
  } else {
    lines.push(`## 該当結果なし`);
    lines.push(``);
    lines.push(`検索結果に orgiast.jp または オージャスト への言及は見つかりませんでした。`);
    lines.push(``);
  }

  return lines.join('\n');
}

/**
 * メインエントリポイント
 */
export async function main(argv = process.argv) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log(HELPTEXT);
    return;
  }

  if (!args.query) {
    throw new Error('--query は必須です。');
  }

  const provider = args.provider || 'gemini';
  if (!PROVIDERS.has(provider)) {
    throw new Error('--provider は gemini, groq, deepseek のいずれかを指定してください。');
  }

  // 検索結果を取得
  let html;
  try {
    html = await fetchSearchResults(args.query);
  } catch (err) {
    throw new Error(`検索結果の取得に失敗しました: ${err.message}`);
  }

  const results = parseDuckDuckGoResults(html);
  const score = analyzeResults(results);

  if (args.json) {
    const output = {
      query: args.query,
      provider,
      timestamp: new Date().toISOString(),
      ...score,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(`\n🔍 AI検索引用チェック`);
    console.log(`   クエリ: "${args.query}"`);
    console.log(`   プロバイダ: ${provider}`);
    console.log(`   日時: ${new Date().toLocaleString('ja-JP')}`);
    console.log(``);
    console.log(`   言及あり: ${score.present ? '✅ YES' : '❌ NO'}`);
    console.log(`   言及数: ${score.mentionCount} / ${score.totalResults}`);
    console.log(`   言及率: ${(score.mentionRate * 100).toFixed(1)}%`);
    console.log(``);

    if (score.snippets.length > 0) {
      console.log(`   該当スニペット:`);
      for (const s of score.snippets) {
        console.log(`     - ${s.title}`);
        console.log(`       ${s.url}`);
        if (s.snippet) console.log(`       「${s.snippet}」`);
      }
    }
    console.log(``);
  }

  if (args.output) {
    const fs = await import('node:fs');
    const md = formatMarkdown(score, args.query, provider);
    fs.writeFileSync(args.output, md, 'utf-8');
    const message = `📝 レポートを出力しました: ${args.output}`;
    if (args.json) console.error(message);
    else console.log(message);
  }

  return score;
}

// ── CLI実行 ──
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(err => {
    console.error(`エラー: ${err.message}`);
    process.exitCode = 1;
  });
}
