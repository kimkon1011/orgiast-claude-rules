#!/usr/bin/env node
/** Phase 1: 自社サイトと競合サイトのクロール */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN_MOCK_DATA = [
  { url: 'https://orgiast.jp/', title: 'オージャスト | 展示会ブース制作・イベント企画', h1: '展示会ブース制作ならオージャスト', description: '展示会ブース制作・イベント企画のオージャスト' },
  { url: 'https://orgiast.jp/service', title: 'サービス一覧 | オージャスト', h1: 'サービス一覧', description: '展示会ブース制作、Reブース、イベントプロデュース' },
  { url: 'https://orgiast.jp/service/booth', title: '展示会ブース制作 | オージャスト', h1: '展示会ブース制作', description: '企画・デザイン・施工・運営までトータルサポート' },
  { url: 'https://rebooth.co.jp/', title: 'Reブース | リユース展示会ブース', h1: 'Reブース - サステナブルな展示会ブース', description: 'SDGsに対応したリユース展示会ブースのレンタル・販売' },
];

const decodeEntities = value => value
  .replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'")
  .replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&nbsp;/gi, ' ')
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));

function stripTags(value = '') {
  return decodeEntities(value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim());
}

function extractPage(html, pageUrl) {
  const title = html.match(/<title>([^<]*)<\/title>/i)?.[1] || '';
  const h1 = html.match(/<h1[^>]*>([^<]*)<\/h1>/i)?.[1] || '';
  const description = html.match(/<meta[^>]*name=["']description["'][^>]*content=["']([^"']*)["'][^>]*\/?>/i)?.[1]
    || html.match(/<meta[^>]*content=["']([^"']*)["'][^>]*name=["']description["'][^>]*\/?>/i)?.[1]
    || '';
  const links = [];
  const linkPattern = /<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>/gi;
  for (const match of html.matchAll(linkPattern)) {
    try {
      const link = new URL(decodeEntities(match[1]), pageUrl);
      link.hash = '';
      if (link.protocol === 'http:' || link.protocol === 'https:') links.push(link.href);
    } catch { /* 不正なリンクは無視 */ }
  }
  return { url: pageUrl, title: stripTags(title), h1: stripTags(h1), description: stripTags(description), links: [...new Set(links)] };
}

function parseRobots(text, userAgent) {
  const groups = [];
  let agents = [];
  let rules = [];
  const flush = () => { if (agents.length) groups.push({ agents, rules }); agents = []; rules = []; };
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const match = line.match(/^([\w-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'user-agent') {
      if (rules.length) flush();
      agents.push(value.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && agents.length) rules.push({ type: key, path: value });
  }
  flush();
  const ua = userAgent.toLowerCase();
  const exact = groups.filter(group => group.agents.some(agent => agent !== '*' && ua.includes(agent)));
  const selected = exact.length ? exact : groups.filter(group => group.agents.includes('*'));
  return selected.flatMap(group => group.rules).filter(rule => rule.path);
}

function robotsAllows(url, rules) {
  const pathname = `${url.pathname}${url.search}`;
  const matching = rules.filter(rule => pathname.startsWith(rule.path.replace(/\*.*$/, ''))).sort((a, b) => b.path.length - a.path.length);
  return matching.length === 0 || matching[0].type === 'allow';
}

function createRequester({ userAgent, timeoutMs, delayMs }) {
  let lastRequestAt = 0;
  return async url => {
    const remaining = delayMs - (Date.now() - lastRequestAt);
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
    lastRequestAt = Date.now();
    return fetch(url, { headers: { 'User-Agent': userAgent }, redirect: 'follow', signal: AbortSignal.timeout(timeoutMs) });
  };
}

async function crawlPage(startUrl, maxDepth, maxPages, request, userAgent) {
  const root = new URL(startUrl);
  const seen = new Set();
  const pages = [];
  const queue = [{ url: root.href, depth: 0 }];
  let errors = 0;
  let robotsRules = [];
  try {
    const response = await request(new URL('/robots.txt', root).href);
    if (response.ok) robotsRules = parseRobots(await response.text(), userAgent);
  } catch (error) {
    console.error(`  robots.txt 取得失敗（全許可として継続）: ${root.origin}: ${error.message}`);
  }
  while (queue.length && pages.length < maxPages) {
    const current = queue.shift();
    let url;
    try { url = new URL(current.url); url.hash = ''; } catch { continue; }
    const normalized = url.href;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    if (url.origin !== root.origin || !robotsAllows(url, robotsRules)) continue;
    try {
      const response = await request(normalized);
      if (response.status !== 200) {
        errors += 1;
        console.error(`  取得をスキップ: ${response.status} ${normalized}`);
        continue;
      }
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) continue;
      const page = extractPage(await response.text(), response.url || normalized);
      pages.push(page);
      if (current.depth < maxDepth) {
        for (const link of page.links) {
          const next = new URL(link);
          if (next.origin === root.origin && !seen.has(next.href)) queue.push({ url: next.href, depth: current.depth + 1 });
        }
      }
    } catch (error) {
      errors += 1;
      console.error(`  取得失敗: ${normalized}: ${error.message}`);
    }
  }
  return { pages, errors };
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const dryRunIndex = rawArgs.indexOf('--dry-run');
  const isDryRun = dryRunIndex >= 0;
  const outdir = isDryRun && rawArgs[dryRunIndex + 1] && !rawArgs[dryRunIndex + 1].startsWith('--') ? path.resolve(rawArgs[dryRunIndex + 1]) : null;
  if (isDryRun && !outdir) throw new Error('使用法: node process/phase1-crawl.mjs --dry-run <outdir>');
  const filteredArgs = rawArgs.filter((_, i) => i !== dryRunIndex && i !== dryRunIndex + 1);
  const configPath = filteredArgs[0] || path.join(__dirname, '..', 'data', 'competitors.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const adjustmentPath = path.join(path.dirname(configPath), 'adjustment-params.json');
  let maxDepth = 3;
  try { maxDepth = JSON.parse(fs.readFileSync(adjustmentPath, 'utf-8')).crawl?.max_depth ?? 3; } catch { /* 既定値 */ }
  const settings = config.settings || {};
  const userAgent = settings.user_agent || 'OrgiastSEOAgent/1.0 (+https://orgiast.jp)';
  const request = createRequester({ userAgent, timeoutMs: settings.request_timeout_ms ?? 15000, delayMs: (settings.crawl_delay_s ?? 1) * 1000 });
  const allDomains = [...config.orgiast_domains, ...config.competitors];
  const results = [];
  let totalErrors = 0;
  if (isDryRun) {
    for (const domain of allDomains) results.push({ domain, pages: DRY_RUN_MOCK_DATA.filter(page => page.url.startsWith(domain)) });
    console.log('  [dry-run] 固定モックデータを使用');
  } else {
    for (const domain of allDomains) {
      const result = await crawlPage(domain, maxDepth, settings.max_pages_per_site ?? 200, request, userAgent);
      results.push({ domain, pages: result.pages });
      totalErrors += result.errors;
      console.log(`  ${domain}: ${result.pages.length}ページ`);
    }
    console.log(`  クロールエラー: ${totalErrors}件`);
  }
  const outPath = path.join(isDryRun ? outdir : path.join(__dirname, '..', 'output'), 'crawl-results.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Phase 1 complete: ${results.length} sites → ${outPath}`);
}

main().catch(error => { console.error('Phase 1 failed:', error.message); process.exit(1); });
