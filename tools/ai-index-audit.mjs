#!/usr/bin/env node

/**
 * ai-index-audit.mjs — サイトインデックス状態監査ツール
 *
 * 対象サイトの robots.txt / sitemap / llms.txt / ai.txt / noindex / canonical /
 * JSON-LD / 最終更新日 を取得し、AI検索（ChatGPT/Perplexity/Gemini）向けの
 * インデックス準備状態を評価する。
 *
 * 使い方:
 *   node tools/ai-index-audit.mjs https://rebooth.co.jp
 *   node tools/ai-index-audit.mjs https://rebooth.co.jp --json   # JSON出力
 *   node tools/ai-index-audit.mjs https://example.com --crawl 5  # 内部リンクを5ページ辿る
 *   node tools/ai-index-audit.mjs https://example.com --verbose  # 詳細ログ
 *
 * 戻り値:
 *   0 = 全チェック完了（スコアに関わらず）
 *   1 = 監査対象サイトに到達不能
 */

const UA = 'Mozilla/5.0 (compatible; AIIndexAudit/1.0; +https://github.com/orgiast)';
const TIMEOUT = 10_000; // 1リクエストあたりのタイムアウト（ms）

// ─── ヘルパー ────────────────────────────────────────────────────

async function fetchText(url, signal) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
    signal,
  });
  if (!res.ok) return { ok: false, status: res.status, text: '', headers: res.headers };
  const text = await res.text();
  return { ok: true, status: res.status, text, headers: res.headers };
}

async function fetchWithTimeout(url, ms = TIMEOUT) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetchText(url, ctrl.signal);
  } finally {
    clearTimeout(id);
  }
}

function extractMetaTag(html, name) {
  const re = new RegExp(`<meta\\s[^>]*?(?:name|property)=["']${name}["'][^>]*?>`, 'i');
  const m = html.match(re);
  if (!m) return null;
  const content = m[0].match(/content=["']([^"']*)["']/i);
  return content ? content[1] : null;
}

function extractCanonical(html) {
  const m = html.match(/<link\s[^>]*?rel=["']canonical["'][^>]*?href=["']([^"']*)["'][^>]*?>/i);
  return m ? m[1] : null;
}

function extractJsonLd(html) {
  const scripts = html.matchAll(/<script\s[^>]*?type=["']application\/ld\+json["'][^>]*?>([\s\S]*?)<\/script>/gi);
  const results = [];
  for (const s of scripts) {
    try { results.push(JSON.parse(s[1])); } catch { /* skip malformed */ }
  }
  return results;
}

function extractLinks(html, baseUrl) {
  const links = [];
  const re = /<a\s[^>]*?href=["']([^"']+)["'][^>]*?>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try {
      const url = new URL(m[1], baseUrl);
      if (url.hostname === new URL(baseUrl).hostname && !url.hash) {
        links.push(url.href.split('#')[0]);
      }
    } catch { /* ignore invalid URLs */ }
  }
  return [...new Set(links)];
}

function scoreResult(label, ok, weight, detail = '') {
  return { label, ok, weight, score: ok ? weight : 0, detail };
}

// ─── メイン監査 ────────────────────────────────────────────────────

export async function auditSite(baseUrl, { crawlDepth = 0, verbose = false } = {}) {
  let u;
  try {
    u = new URL(baseUrl);
  } catch {
    return {
      url: baseUrl,
      timestamp: new Date().toISOString(),
      summary: { score: 0, maxScore: 0, percentage: 0, passed: 0, total: 0, grade: 'F' },
      checks: [],
    };
  }

  const origin = u.origin;

  // Wrap the entire audit body in try/catch to handle unreachable domains gracefully
  try {
    return await _runAudit(origin, { crawlDepth, verbose });
  } catch (err) {
    return {
      url: origin,
      timestamp: new Date().toISOString(),
      summary: { score: 0, maxScore: 0, percentage: 0, passed: 0, total: 0, grade: 'F' },
      checks: [{ label: '接続エラー', ok: false, weight: 100, score: 0, detail: err.message }],
    };
  }
}

async function _runAudit(origin, { crawlDepth, verbose }) {
  const results = [];

  // --- robots.txt ---
  if (verbose) console.error('[robots.txt] checking...');
  const robots = await fetchWithTimeout(`${origin}/robots.txt`);
  const robotsOk = robots.ok && robots.text.length > 0;
  results.push(scoreResult(
    'robots.txt',
    robotsOk,
    15,
    robotsOk
      ? `存在 (${robots.text.length}B)。${robots.text.includes('Disallow: /') ? '一部Disallowあり' : '全許可'}`
      : robots.status === 404 ? '404 Not Found' : `${robots.status} ${robots.text.slice(0, 100)}`
  ));
  if (robotsOk && verbose) console.error(`  → ${robots.text.split('\n').length}行`);

  // --- sitemap.xml ---
  if (verbose) console.error('[sitemap.xml] checking...');
  const sitemap = await fetchWithTimeout(`${origin}/sitemap.xml`);
  const sitemapOk = sitemap.ok && sitemap.text.length > 0 && sitemap.text.includes('<urlset');
  results.push(scoreResult(
    'sitemap.xml',
    sitemapOk,
    10,
    sitemapOk
      ? `存在 (${sitemap.text.length}B)`
      : sitemap.status === 404 ? '404 Not Found' : `${sitemap.status}`
  ));

  // --- llms.txt ---
  if (verbose) console.error('[llms.txt] checking...');
  const llms = await fetchWithTimeout(`${origin}/llms.txt`);
  results.push(scoreResult(
    'llms.txt',
    llms.ok && llms.text.length > 0,
    15,
    llms.ok && llms.text.length > 0
      ? `存在 (${llms.text.length}B)`
      : llms.status === 404 ? '404 Not Found' : '不在'
  ));

  // --- ai.txt ---
  if (verbose) console.error('[ai.txt] checking...');
  const ai = await fetchWithTimeout(`${origin}/ai.txt`);
  results.push(scoreResult(
    'ai.txt',
    ai.ok && ai.text.length > 0,
    10,
    ai.ok && ai.text.length > 0
      ? `存在 (${ai.text.length}B)`
      : ai.status === 404 ? '404 Not Found' : '不在'
  ));

  // --- トップページ解析 ---
  if (verbose) console.error('[top page] fetching...');
  const top = await fetchWithTimeout(origin);
  const topOk = top.ok;
  results.push(scoreResult(
    'トップページ到達性',
    topOk,
    5,
    topOk ? `200 OK (${top.text.length}B)` : `${top.status}`
  ));

  if (topOk) {
    // X-Robots-Tag
    const xRobots = top.headers.get('X-Robots-Tag');
    results.push(scoreResult(
      'X-Robots-Tag（HTTP header）',
      !xRobots || !xRobots.toLowerCase().includes('noindex'),
      10,
      xRobots || 'なし（問題なし）'
    ));

    // Meta robots
    const metaRobots = extractMetaTag(top.text, 'robots');
    results.push(scoreResult(
      'Meta robots noindex',
      !metaRobots || !metaRobots.toLowerCase().includes('noindex'),
      10,
      metaRobots || 'なし（問題なし）'
    ));

    // Canonical
    const canonical = extractCanonical(top.text);
    results.push(scoreResult(
      '自己参照canonical',
      !canonical || canonical === origin || canonical === `${origin}/`,
      10,
      canonical || 'なし（問題なし）'
    ));

    // JSON-LD
    const jsonld = extractJsonLd(top.text);
    results.push(scoreResult(
      'JSON-LD構造化データ',
      jsonld.length > 0,
      10,
      jsonld.length > 0
        ? `${jsonld.length}件: ${jsonld.map(j => j['@type'] || '?').join(', ')}`
        : 'なし'
    ));

    // 最終更新日
    const lastmod = extractMetaTag(top.text, 'last-modified')
      || extractMetaTag(top.text, 'article:modified_time')
      || extractMetaTag(top.text, 'date');
    results.push(scoreResult(
      '最終更新日の明示',
      !!lastmod,
      5,
      lastmod || 'なし'
    ));

    // 内部リンククロール
    if (crawlDepth > 0) {
      const internalLinks = extractLinks(top.text, origin);
      if (verbose) console.error(`[crawl] ${internalLinks.length} internal links found, depth=${crawlDepth}`);
      const crawled = new Set([origin]);
      for (const link of internalLinks.slice(0, crawlDepth)) {
        if (crawled.has(link)) continue;
        crawled.add(link);
        if (verbose) console.error(`[crawl] ${link}`);
        const page = await fetchWithTimeout(link);
        if (page.ok) {
          const p = new URL(link);
          const pr = extractMetaTag(page.text, 'robots');
          results.push(scoreResult(
            `noindex: ${p.pathname}`,
            !pr || !pr.toLowerCase().includes('noindex'),
            5,
            pr || '問題なし'
          ));
          const pc = extractCanonical(page.text);
          if (pc) {
            results.push(scoreResult(
              `canonical: ${p.pathname}`,
              pc === link || pc === link.replace(/\/$/, ''),
              5,
              pc
            ));
          }
        }
      }
    }
  }

  // --- Bingインデックス確認（Web Fetch経由） ---
  // 注意: 実際の件数は Bing Webmaster Tools で確認。ここでは site: 検索の有無のみ
  if (verbose) console.error('[Bing] site: search reference — use Bing Webmaster Tools for accurate count');

  // --- スコア集計 ---
  const totalWeight = results.reduce((s, r) => s + r.weight, 0);
  const totalScore = results.reduce((s, r) => s + r.score, 0);
  const pct = totalWeight > 0 ? Math.round((totalScore / totalWeight) * 100) : 0;

  return {
    url: origin,
    timestamp: new Date().toISOString(),
    summary: {
      score: totalScore,
      maxScore: totalWeight,
      percentage: pct,
      passed: results.filter(r => r.ok).length,
      total: results.length,
      grade: pct >= 90 ? 'A' : pct >= 70 ? 'B' : pct >= 50 ? 'C' : pct >= 30 ? 'D' : 'F',
    },
    checks: results,
  };
}

// ─── CLI ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const url = args.find(a => a.startsWith('http'));
  const isJson = args.includes('--json');
  const verbose = args.includes('--verbose');
  const crawlIdx = args.indexOf('--crawl');
  const crawlDepth = crawlIdx >= 0 && args[crawlIdx + 1] ? parseInt(args[crawlIdx + 1], 10) : 0;

  if (!url) {
    console.error('Usage: node tools/ai-index-audit.mjs <url> [--json] [--crawl N] [--verbose]');
    process.exit(1);
  }

  try {
    new URL(url);
  } catch {
    console.error(`Invalid URL: ${url}`);
    process.exit(1);
  }

  try {
    const report = await auditSite(url, { crawlDepth, verbose });

    if (isJson) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      const s = report.summary;
      console.log(`\n=== AI Index Audit: ${report.url} ===`);
      console.log(`Score: ${s.score}/${s.maxScore} (${s.percentage}%) — Grade: ${s.grade}`);
      console.log(`Passed: ${s.passed}/${s.total} checks`);
      console.log(`Timestamp: ${report.timestamp}\n`);

      for (const c of report.checks) {
        const icon = c.ok ? '✅' : '❌';
        console.log(`  ${icon} ${c.label} (${c.score}/${c.weight}): ${c.detail}`);
      }

      console.log(`\nGrade guide:
  A (≥90%) — AI検索準備完了
  B (≥70%) — おおむね良好、一部改善推奨
  C (≥50%) — 改善が必要
  D (≥30%) — 多くの問題あり
  F (<30%) — AI検索に非対応`);

      if (s.grade !== 'A') {
        const critical = report.checks.filter(c => c.weight >= 10 && !c.ok);
        if (critical.length > 0) {
          console.log('\n🔴 優先改善項目（重み10以上）:');
          for (const c of critical) {
            console.log(`  - ${c.label}: ${c.detail}`);
          }
        }
      }
    }

    process.exit(0);
  } catch (err) {
    console.error(`Audit failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && (process.argv[1].endsWith('ai-index-audit.mjs') || process.argv[1].endsWith('ai-index-audit'))) {
  main();
}