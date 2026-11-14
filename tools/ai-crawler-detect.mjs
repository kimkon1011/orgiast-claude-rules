#!/usr/bin/env node
// AI crawler detection module — X-0052
// Detects known AI crawlers by User-Agent string and logs them server-side.
// No external dependencies; Node.js 20+ built-ins only.
import { writeFileSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * @typedef {Object} CrawlerDefinition
 * @property {string} name        - Canonical crawler name
 * @property {string} uaPattern   - RegExp source string to match User-Agent
 * @property {string} category    - One of 'training', 'inference', 'scraping'
 * @property {string} description - Human-readable description
 */

/** @type {CrawlerDefinition[]} */
export const CRAWLER_PATTERNS = [
  // ── training (training-data collection bots) ──
  { name: 'GPTBot',          uaPattern: 'GPTBot',              category: 'training',  description: 'OpenAI GPT training data collector' },
  { name: 'Google-Extended', uaPattern: 'Google-Extended',     category: 'training',  description: 'Google AI training (Gemini etc.)' },
  { name: 'CCBot',           uaPattern: 'CCBot',               category: 'training',  description: 'Common Crawl bot (used for LLM training)' },
  { name: 'Claude-Web',      uaPattern: 'Claude-Web',          category: 'training',  description: 'Anthropic Claude web crawler' },
  { name: 'Applebot',        uaPattern: 'Applebot',            category: 'training',  description: 'Apple AI crawler' },
  { name: 'FacebookBot',     uaPattern: 'FacebookBot',         category: 'training',  description: 'Meta/Facebook AI crawler' },
  { name: 'CommonCrawl',     uaPattern: 'CommonCrawl',         category: 'training',  description: 'CommonCrawl generic crawler' },

  // ── inference (real-time answering bots) ──
  { name: 'PerplexityBot',   uaPattern: 'PerplexityBot',       category: 'inference', description: 'Perplexity AI answer bot' },
  { name: 'ChatGPT-User',    uaPattern: 'ChatGPT-User',        category: 'inference', description: 'ChatGPT user request (via browsing plugin)' },
  { name: 'Bard',            uaPattern: 'Bard',                category: 'inference', description: 'Google Bard/Gemini answering bot' },
  { name: 'BingAI',          uaPattern: 'BingAI',              category: 'inference', description: 'Microsoft Bing AI answer bot' },
  { name: 'YouBot',          uaPattern: 'YouBot',              category: 'inference', description: 'You.com AI answer bot' },

  // ── scraping (general-purpose AI scrapers) ──
  { name: 'Bytespider',      uaPattern: 'Bytespider',          category: 'scraping',  description: 'ByteDance AI scraper' },
  { name: 'AmazonBot',       uaPattern: 'AmazonBot',           category: 'scraping',  description: 'Amazon AI scraping bot' },
  { name: 'DataForSeoBot',   uaPattern: 'DataForSEO',          category: 'scraping',  description: 'DataForSEO rank-tracking bot' },
  { name: 'Diffbot',         uaPattern: 'Diffbot',             category: 'scraping',  description: 'Diffbot AI scraping/classification' },
  { name: 'Trendiction',     uaPattern: 'Trendiction',         category: 'scraping',  description: 'Trendiction brand-monitoring crawler' },
  { name: 'SeekerBot',       uaPattern: 'SeekerBot',           category: 'scraping',  description: 'SeekerBot SEO/data crawler' },
  { name: 'SemifyBot',       uaPattern: 'SemifyBot',           category: 'scraping',  description: 'Semify semantic crawler' },
  { name: 'MozBot',          uaPattern: 'MozBot',              category: 'scraping',  description: 'Moz SEO crawler' },
  { name: 'AhrefsBot',       uaPattern: 'AhrefsBot',           category: 'scraping',  description: 'Ahrefs SEO crawler' },
  { name: 'SemrushBot',      uaPattern: 'SemrushBot',          category: 'scraping',  description: 'Semrush SEO crawler' },
];

// Compiled regex patterns (once)
let compiledPatterns = null;
function getCompiled() {
  if (!compiledPatterns) {
    compiledPatterns = CRAWLER_PATTERNS.map(c => ({
      ...c,
      regex: new RegExp(c.uaPattern, 'i'),
    }));
  }
  return compiledPatterns;
}

/**
 * Detect AI crawler from a User-Agent string.
 * @param {string} userAgent - The User-Agent header value
 * @returns {{ isAi: boolean, name: string, category: string, version: string }}
 */
export function detectCrawler(userAgent) {
  if (!userAgent || typeof userAgent !== 'string') {
    return { isAi: false, name: '', category: '', version: '' };
  }
  for (const c of getCompiled()) {
    const m = userAgent.match(c.regex);
    if (m) {
      // Attempt to extract version if present after name
      const rest = userAgent.substring(m.index + m[0].length);
      const verMatch = rest.match(/[/\s]?([\d.]+)/);
      const version = verMatch ? verMatch[1] : '';
      return { isAi: true, name: c.name, category: c.category, version };
    }
  }
  return { isAi: false, name: '', category: '', version: '' };
}

/**
 * Parse an nginx/apache combined log line and detect AI crawler.
 * @param {string} logLine - A single log line (combined log format)
 * @returns {{ detection: object, remoteAddr: string, method: string, path: string, status: string } | null}
 */
export function classifyLog(logLine) {
  if (!logLine || typeof logLine !== 'string') return null;
  // Combined log format: IP - - [date] "METHOD PATH PROTO" STATUS SIZE "REFERER" "UA"
  const re = /^(\S+)\s+\S+\s+\S+\s+\[[^\]]+\]\s+"(\S+)\s+(\S+)\s+\S+"\s+(\d+)\s+\d+\s+"[^"]*"\s+"([^"]+)"/;
  const m = logLine.match(re);
  if (!m) return null;
  const [, remoteAddr, method, reqPath, status, ua] = m;
  const detection = detectCrawler(ua);
  return { detection, remoteAddr, method, path: reqPath, status };
}

/**
 * Generate an nginx map block for AI crawler detection (write to file).
 * @param {string} outputPath - File path for the nginx snippet
 */
export function generateNginxMap(outputPath) {
  const lines = [
    '# AI crawler detection map — auto-generated by ai-crawler-detect.mjs',
    '# Include this file from nginx.conf with: include /etc/nginx/ai-crawler-map.conf;',
    '# Then use variables $ai_crawler_name, $ai_crawler_category, $ai_crawler_is_ai in server blocks.',
    '',
    'map $http_user_agent $ai_crawler_is_ai {',
    '  default 0;',
  ];
  const catLines = ['', 'map $http_user_agent $ai_crawler_category {', '  default "";'];
  const nameLines = ['', 'map $http_user_agent $ai_crawler_name {', '  default "";'];

  for (const c of CRAWLER_PATTERNS) {
    const escaped = c.uaPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    lines.push(`  "~*${escaped}" 1;`);
    catLines.push(`  "~*${escaped}" "${c.category}";`);
    nameLines.push(`  "~*${escaped}" "${c.name}";`);
  }

  lines.push('}');
  catLines.push('}');
  nameLines.push('}');

  const full = lines.join('\n') + catLines.join('\n') + nameLines.join('\n') + '\n';
  writeFileSync(outputPath, full, 'utf-8');
}

/**
 * Log an AI crawler request to a JSONL file.
 * @param {object} detection - Result from detectCrawler()
 * @param {object} req - Request info: { remoteAddr?, method?, path?, status?, timestamp? }
 * @param {string} [logPath] - Override log file path (default: logs/ai-crawler.log)
 */
export function logRequest(detection, req, logPath) {
  if (!detection || !detection.isAi) return;
  const logFile = logPath || 'logs/ai-crawler.log';
  const dir = dirname(logFile);
  mkdirSync(dir, { recursive: true });
  const entry = {
    ts: req.timestamp || new Date().toISOString(),
    name: detection.name,
    category: detection.category,
    version: detection.version,
    remoteAddr: req.remoteAddr || '',
    method: req.method || '',
    path: req.path || '',
    status: req.status || '',
  };
  // Append to file using open with O_APPEND | O_CREAT | O_WRONLY
  const fd = openSync(logFile, 2024 /* O_APPEND | O_CREAT | O_WRONLY */, 0o644);
  writeSync(fd, JSON.stringify(entry) + '\n');
  closeSync(fd);
}

// ── CLI entry point ──
// Guard: only run when invoked directly (not when imported as module)
const validCmds = ['detect', 'classify', 'nginx', 'list'];
const cmd = process.argv[2] || '';
const args = process.argv.slice(3);
if (validCmds.includes(cmd)) {
  if (cmd === 'detect' && args[0]) {
    const r = detectCrawler(args[0]);
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'classify' && args[0]) {
    const r = classifyLog(args[0]);
    console.log(JSON.stringify(r, null, 2));
  } else if (cmd === 'nginx' && args[0]) {
    generateNginxMap(args[0]);
    console.log('nginx map written to', args[0]);
  } else if (cmd === 'list') {
    console.log(JSON.stringify(CRAWLER_PATTERNS, null, 2));
  } else {
    console.log(`Usage:
  node tools/ai-crawler-detect.mjs detect "<user-agent>"    — Detect AI crawler from UA
  node tools/ai-crawler-detect.mjs classify "<log-line>"    — Parse combined-log line
  node tools/ai-crawler-detect.mjs nginx <output-path>      — Generate nginx map block
  node tools/ai-crawler-detect.mjs list                      — List all known crawlers`);
  }
}