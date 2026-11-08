#!/usr/bin/env node
/**
 * Phase 1: サイトクロール
 *
 * 自社サイト + 競合サイトをクロールし、ページのURL・タイトル・H1・メタディスクリプションを抽出する。
 *
 * 使用法:
 *   node process/phase1-crawl.mjs
 *   node process/phase1-crawl.mjs --dry-run <outdir>   (dry-run: test/fixtures から固定サンプルを読んで出力)
 *
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY_RUN_MOCK_DATA = [
  { url: 'https://orgiast.jp/', title: 'オージャスト | 展示会ブース制作・イベント企画', h1: '展示会ブース制作ならオージャスト', description: '展示会ブース制作・イベント企画のオージャスト' },
  { url: 'https://orgiast.jp/service', title: 'サービス一覧 | オージャスト', h1: 'サービス一覧', description: '展示会ブース制作、Reブース、イベントプロデュース' },
  { url: 'https://orgiast.jp/service/booth', title: '展示会ブース制作 | オージャスト', h1: '展示会ブース制作', description: '企画・デザイン・施工・運営までトータルサポート' },
  { url: 'https://rebooth.co.jp/', title: 'Reブース | リユース展示会ブース', h1: 'Reブース - サステナブルな展示会ブース', description: 'SDGsに対応したリユース展示会ブースのレンタル・販売' },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, key) => {
    if (!key.startsWith('#')) return named[key.toLowerCase()];
    const code = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
  });
}

function normalizeUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

function parseHtml(html, url) {
  // A lightweight parser: ignore comments/raw script text before scanning tags.
  const source = html.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const text = value => decodeEntities(value.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  const first = tag => text(source.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, 'i'))?.[1] || '');
  const attributes = tag => {
    const attrs = {};
    for (const match of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4]);
    }
    return attrs;
  };
  let description = '';
  const links = new Set();
  for (const match of source.matchAll(/<(meta|a)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
    const attrs = attributes(match[0]);
    if (match[1].toLowerCase() === 'meta' && attrs.name?.toLowerCase() === 'description') {
      description = attrs.content || '';
    } else if (match[1].toLowerCase() === 'a' && attrs.href) {
      const link = normalizeUrl(attrs.href, url);
      if (link && new URL(link).host === new URL(url).host) links.add(link);
    }
  }
  const headings = [...source.matchAll(/<(h[23])\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(m => text(m[2]));
  return { url, title: first('title'), h1: first('h1'), description, headings, links: [...links] };
}

function parseRobots(body, userAgent) {
  const groups = [];
  let group;
  for (const line of body.split(/\r?\n/)) {
    const match = line.replace(/#.*$/, '').match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const [, rawKey, value] = match;
    const key = rawKey.toLowerCase();
    if (key === 'user-agent') {
      if (!group || group.started) { group = { agents: [], rules: [], delay: 0, started: false }; groups.push(group); }
      group.agents.push(value.toLowerCase());
    } else if (group) {
      group.started = true;
      if ((key === 'allow' || key === 'disallow') && value) {
        const end = value.endsWith('$');
        const pattern = (end ? value.slice(0, -1) : value).split('*')
          .map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
        group.rules.push({ allow: key === 'allow', length: value.replace(/[*$]/g, '').length, re: new RegExp('^' + pattern + (end ? '$' : '')) });
      }
      if (key === 'crawl-delay' && Number.isFinite(Number(value))) group.delay = Math.max(0, Number(value));
    }
  }
  const score = g => Math.max(-1, ...g.agents.map(a => a === '*' ? 0 : userAgent.toLowerCase().includes(a) ? a.length : -1));
  const best = Math.max(-1, ...groups.map(score));
  const selected = best < 0 ? [] : groups.filter(g => score(g) === best);
  const rules = selected.flatMap(g => g.rules);
  return {
    delay: Math.max(0, ...selected.map(g => g.delay)),
    allows(url) {
      const target = new URL(url);
      const matches = rules.filter(r => r.re.test(target.pathname + target.search))
        .sort((a, b) => b.length - a.length || Number(b.allow) - Number(a.allow));
      return !matches.length || matches[0].allow;
    },
  };
}

async function request(url, context) {
  await sleep(Math.max(0, context.lastRequest + context.delay - Date.now()));
  context.lastRequest = Date.now();
  return new Promise((resolve, reject) => {
    const client = new URL(url).protocol === 'https:' ? https : http;
    const req = client.get(url, { headers: { 'User-Agent': context.userAgent, 'Accept-Encoding': 'identity' } }, res => {
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > 5 * 1024 * 1024) req.destroy(new Error('Response exceeds 5 MiB'));
        else chunks.push(chunk);
      });
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    const timer = setTimeout(() => req.destroy(new Error('Request timed out')), context.timeout);
    req.on('error', reject);
    req.on('close', () => clearTimeout(timer));
  });
}

async function robotsFor(url, context) {
  const origin = new URL(url).origin;
  if (context.robots.has(origin)) return context.robots.get(origin);
  let current = new URL('/robots.txt', origin).href;
  let policy;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      const response = await request(current, context);
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const next = normalizeUrl(response.headers.location, current);
        if (!response.headers.location || !next || new URL(next).origin !== origin || hop === 5) throw new Error('Unsupported robots redirect');
        current = next;
        continue;
      }
      if (response.status === 404 || response.status === 410) policy = parseRobots('', context.userAgent);
      else if (response.status >= 200 && response.status < 300) policy = parseRobots(response.body, context.userAgent);
      else throw new Error(`HTTP ${response.status}`);
      break;
    }
  } catch (error) {
    context.errors++;
    console.warn(`  robots ${origin}: ${error.message}; skipping site`);
    policy = { allows: () => false, delay: 0 };
  }
  context.delay = Math.max(context.delay, policy.delay * 1000);
  context.robots.set(origin, policy);
  return policy;
}

async function crawlPage(url, depth, maxDepth, context, seen, redirects = 0) {
  url = normalizeUrl(url);
  if (!url || new URL(url).host !== context.host || depth > maxDepth || seen.has(url) || context.attempts >= context.maxPages) return [];
  seen.add(url);
  try {
    if (!(await robotsFor(url, context)).allows(url)) return [];
    context.attempts++;
    const response = await request(url, context);
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.headers.location || redirects >= 5) throw new Error('Invalid or excessive redirects');
      const target = normalizeUrl(response.headers.location, url);
      return await crawlPage(target, depth, maxDepth, context, seen, redirects + 1);
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    if (!/^(text\/html|application\/xhtml\+xml)\b/i.test(response.headers['content-type'] || '')) return [];
    const page = parseHtml(response.body, url);
    const pages = [page];
    for (const link of page.links) pages.push(...await crawlPage(link, depth + 1, maxDepth, context, seen));
    return pages;
  } catch (error) {
    context.errors++;
    console.warn(`  ${url}: ${error.message}`);
    return [];
  }
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const dryRunIndex = process.argv.indexOf('--dry-run');
  const outdir = isDryRun && dryRunIndex + 1 < process.argv.length
    ? path.resolve(process.argv[dryRunIndex + 1])
    : null;

  if (isDryRun && !outdir) {
    console.error('Usage: node process/phase1-crawl.mjs --dry-run <outdir>');
    process.exit(1);
  }

  // --dry-run とその値を argv から除外して設定ファイルパスを取得
  const rawArgs = process.argv.slice(2);
  const filteredArgs = rawArgs.filter((a, i, arr) => {
    if (a === '--dry-run') return false;
    if (i > 0 && arr[i - 1] === '--dry-run') return false;
    return true;
  });
  const configPath = filteredArgs[0] || path.join(__dirname, '..', 'data', 'competitors.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  let results;
  if (isDryRun) {
    // Dry-run: ネットワークを使わず固定モックデータを使用
    const allDomains = [...config.orgiast_domains, ...config.competitors];
    results = allDomains.map(domain => {
      const domainPages = DRY_RUN_MOCK_DATA.filter(p => p.url.startsWith(domain));
      return { domain, pages: domainPages };
    });
    console.log('  [dry-run] using mock data');
  } else {
    const allDomains = [...config.orgiast_domains, ...config.competitors];
    results = [];
    let errors = 0;
    for (const domain of allDomains) {
      const settings = config.settings || {};
      const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
      const context = {
        host: new URL(domain).host,
        delay: Math.max(1000, positive(settings.crawl_delay_s, 1) * 1000),
        timeout: positive(settings.request_timeout_ms, 15000),
        userAgent: settings.user_agent || 'OrgiastSEOAgent/1.0',
        maxPages: Math.max(1, Math.floor(positive(settings.max_pages_per_site, 200))),
        attempts: 0, errors: 0, lastRequest: 0, robots: new Map(),
      };
      const pages = await crawlPage(domain, 0, 3, context, new Set());
      errors += context.errors;
      results.push({ domain, pages });
      console.log(`  ${domain}: ${pages.length} pages, ${context.errors} errors`);
    }
    console.log(`Crawl summary: ${errors} errors`);
  }

  const outPath = isDryRun
    ? path.join(outdir, 'crawl-results.json')
    : path.join(__dirname, '..', 'output', 'crawl-results.json');

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(results, null, 2));
  console.log(`Phase 1 complete: ${results.length} sites → ${outPath}`);
}

main().catch(e => {
  console.error('Phase 1 failed:', e.message);
  process.exit(1);
});