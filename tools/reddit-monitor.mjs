#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
/**
 * reddit-monitor.mjs — 展示会ブース関連Reddit監視ツール
 *
 * X-0011: SEOとAEOの11の再現可能手法（手法1+3）
 * Redditスレッドを監視し、展示会ブース関連の質問を検出してブログ記事案を生成する。
 *
 * 使い方:
 *   node tools/reddit-monitor.mjs [--search "キーワード"] [--days 7] [--output json|markdown]
 *   node tools/reddit-monitor.mjs --cron         # 前回実行以降の新規投稿をチェック
 *
 * 依存: なし（Reddit JSON API は認証不要の公開データを使用）
 */

export const SUBREDDITS = [
  'japanlife',
  'Tokyo',
  'japanresidents',
  'JapanTravel',
  'startups',
  'smallbusiness',
  'marketing',
  'entrepreneur',
  'japan',
];

// 展示会ブース関連の日本語キーワード
export const BOOTH_KEYWORDS = [
  '展示会', 'ブース', 'イベント出展', '展示会出展',
  '小間', 'ブース制作', '展示会 施工', '展示会 装飾',
  '出展 準備', 'ブース デザイン', '展示会 費用',
  '展示会 集客', '展示会 レイアウト',
];

const DEFAULTS = {
  searchQuery: '展示会 ブース 制作',
  days: 7,
  limit: 25,
  output: 'markdown',
  stateFile: null, // --state-file <path> で指定
};

// ===== Reddit JSON API =====
async function searchReddit(query, { days = 7, limit = 25, after } = {}) {
  const afterEpoch = after || Math.floor(Date.now() / 1000) - days * 86400;
  const url = `https://www.reddit.com/search.json?q=${encodeURIComponent(query)}&sort=new&limit=${limit}&restrict_sr=on&t=all`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': 'orgiast-seo-monitor/1.0' },
  });

  if (!resp.ok) {
    throw new Error(`Reddit API error ${resp.status}: ${resp.statusText}`);
  }

  const data = await resp.json();
  const children = data?.data?.children || [];

  return children
    .map(c => c.data)
    .filter(post => post.created_utc >= afterEpoch)
    .map(post => ({
      id: post.id,
      title: post.title,
      selftext: (post.selftext || '').slice(0, 500),
      subreddit: post.subreddit,
      url: `https://www.reddit.com${post.permalink}`,
      score: post.score,
      numComments: post.num_comments,
      createdUtc: post.created_utc,
      createdDate: new Date(post.created_utc * 1000).toISOString().split('T')[0],
      isQuestion: /(\?|質問|教えて|おすすめ|知りたい|どうすれば|方法|探し|比較)/.test(post.title + ' ' + (post.selftext || '')),
    }));
}

// ===== キーワードマッチング =====
export function matchBoothKeywords(post) {
  const text = (post.title + ' ' + (post.selftext || '')).toLowerCase();
  const matched = BOOTH_KEYWORDS.filter(kw => text.includes(kw.toLowerCase()));
  return matched;
}

// ===== ブログ記事案生成 =====
export function generateBlogIdeas(posts) {
  const boothPosts = posts.filter(p => matchBoothKeywords(p).length > 0);
  if (boothPosts.length === 0) return [];

  return boothPosts.slice(0, 5).map(post => {
    const keywords = matchBoothKeywords(post);
    const title = post.title.replace(/[?？].*$/, '').trim();
    return {
      redditPost: post.url,
      sourceTitle: post.title,
      suggestedTitle: `【${keywords[0] || '展示会出展'}】${title.length > 30 ? title.slice(0, 30) + '…' : title} | 成功のコツと注意点`,
      suggestedSlug: `exhibition-${post.id}`,
      targetKeyword: keywords[0] || '展示会出展',
      relatedKeywords: keywords.slice(1, 4),
      estimatedWordCount: 2000,
      angle: `${post.title} — 実際の出展者の疑問に答える形で専門知識を提供`,
    };
  });
}

// ===== 出力フォーマット =====
function formatMarkdown({ posts, boothPosts, blogIdeas, since }) {
  const lines = [
    `# Reddit 展示会ブース監視レポート`,
    ``,
    `| 項目 | 値 |`,
    `|------|-----|`,
    `| 検索クエリ | ${DEFAULTS.searchQuery} |`,
    `| 期間 | ${since} 以降 |`,
    `| 全取得件数 | ${posts.length} |`,
    `| ブース関連 | ${boothPosts.length} |`,
    `| 質問形式 | ${boothPosts.filter(p => p.isQuestion).length}件 |`,
    ``,
  ];

  if (boothPosts.length === 0) {
    lines.push('## 結果');
    lines.push('');
    lines.push('該当する投稿はありませんでした。');
    return lines.join('\n');
  }

  lines.push('## 🔍 展示会ブース関連投稿');
  lines.push('');
  lines.push('| # | 日付 | サブレ | タイトル | スコア | コメント |');
  lines.push('|---|------|--------|----------|------:|--------:|');

  boothPosts.forEach((p, i) => {
    const title = p.title.length > 50 ? p.title.slice(0, 50) + '…' : p.title;
    lines.push(`| ${i + 1} | ${p.createdDate} | r/${p.subreddit} | [${title}](${p.url}) | ${p.score} | ${p.numComments} |`);
  });

  if (blogIdeas.length > 0) {
    lines.push('');
    lines.push('## 📝 ブログ記事案');
    lines.push('');

    blogIdeas.forEach((idea, i) => {
      lines.push(`### 案${i + 1}: ${idea.suggestedTitle}`);
      lines.push(`- **元Reddit**: [${idea.sourceTitle}](${idea.redditPost})`);
      lines.push(`- **ターゲットKW**: ${idea.targetKeyword}`);
      lines.push(`- **関連KW**: ${idea.relatedKeywords.join('、') || 'なし'}`);
      lines.push(`- **記事角度**: ${idea.angle}`);
      lines.push(`- **推奨文字数**: ${idea.estimatedWordCount}字`);
      lines.push('');
    });
  }

  return lines.join('\n');
}

// ===== 状態ファイル管理 =====
function loadState(statePath) {
  try {
    return JSON.parse(require('fs').readFileSync(statePath, 'utf8'));
  } catch {
    return { lastRun: null, seenIds: [] };
  }
}

function saveState(statePath, state) {
  require('fs').writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

// ===== CLI =====
function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { ...DEFAULTS };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--search': opts.searchQuery = args[++i]; break;
      case '--days': opts.days = parseInt(args[++i]); break;
      case '--limit': opts.limit = parseInt(args[++i]); break;
      case '--output': opts.output = args[++i]; break;
      case '--state-file': opts.stateFile = args[++i]; break;
      case '--cron': opts.cronMode = true; break;
      case '--help':
        console.log(`使い方: reddit-monitor.mjs [options]
  --search <query>    検索クエリ (default: "${DEFAULTS.searchQuery}")
  --days <n>          検索期間 (default: ${DEFAULTS.days})
  --limit <n>         最大取得件数 (default: ${DEFAULTS.limit})
  --output <format>   出力形式 (json|markdown, default: ${DEFAULTS.output})
  --state-file <path> 状態ファイルパス（cronモード用）
  --cron              cron実行モード（新規投稿のみ検出）
  --help              このヘルプ`);
        process.exit(0);
    }
  }

  return opts;
}

// ===== メイン =====
async function main() {
  const opts = parseArgs();

  // cron モード: 状態ファイルで前回実行以降の新規投稿のみ
  let since = new Date(Date.now() - opts.days * 86400000).toISOString().split('T')[0];
  let seenIds = [];

  if (opts.cronMode && opts.stateFile) {
    const state = loadState(opts.stateFile);
    since = state.lastRun || since;
    seenIds = state.seenIds || [];
  }

  console.error(`🔍 Reddit監視: "${opts.searchQuery}" (${since}以降)`);

  const allPosts = await searchReddit(opts.searchQuery, {
    days: opts.days,
    limit: opts.limit,
  });

  // 既読除去（cronモード）
  const newPosts = allPosts.filter(p => !seenIds.includes(p.id));
  const boothPosts = newPosts.filter(p => matchBoothKeywords(p).length > 0);

  // ブログ記事案生成
  const blogIdeas = generateBlogIdeas(boothPosts);

  // 状態保存（cronモード）
  if (opts.cronMode && opts.stateFile) {
    const state = loadState(opts.stateFile);
    state.lastRun = new Date().toISOString();
    state.seenIds = [...new Set([...(state.seenIds || []), ...allPosts.map(p => p.id)])];
    // 古いIDを削除（最大1000件）
    if (state.seenIds.length > 1000) state.seenIds = state.seenIds.slice(-1000);
    saveState(opts.stateFile, state);
  }

  // 出力
  if (opts.output === 'json') {
    console.log(JSON.stringify({
      query: opts.searchQuery,
      since,
      total: allPosts.length,
      boothRelated: boothPosts.length,
      blogIdeas: blogIdeas.length,
      posts: boothPosts,
      blogIdeas,
    }, null, 2));
  } else {
    console.log(formatMarkdown({
      posts: allPosts,
      boothPosts,
      blogIdeas,
      since,
    }));
  }

  console.error(`\n✅ 完了: ${newPosts.length}件中 ${boothPosts.length}件が展示会関連`);
  console.error(`   ブログ記事案: ${blogIdeas.length}件`);
}

if (isEntry(import.meta.url)) {
main().catch(err => {
  console.error('❌ エラー:', err.message);
  process.exit(1);
});
}
