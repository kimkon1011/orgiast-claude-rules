#!/usr/bin/env node
// AI Markdown generation pipeline — X-0052
// Generates AI-crawler-friendly Markdown from site content definitions.
// No external dependencies; Node.js 20+ built-ins only.
import { readFileSync, writeFileSync, mkdirSync, openSync, writeSync, closeSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';

/**
 * @typedef {Object} ContentPage
 * @property {string} id            - Unique page identifier
 * @property {string} title         - Page title (H1)
 * @property {string} description   - One-line description
 * @property {string} url           - Original HTML URL
 * @property {string} markdownPath  - Output path for Markdown file (relative)
 * @property {string} category      - Content category (e.g. 'service', 'case', 'info')
 * @property {string} body          - Markdown body content
 * @property {string[]} [tags]      - Optional tags/keywords
 * @property {string} [lastmod]     - Last modified date (ISO date string)
 */

/** @type {ContentPage[]} */
let contentRegistry = [];

/**
 * Register a content page for Markdown generation.
 * @param {ContentPage} page
 */
export function registerContent(page) {
  contentRegistry.push(page);
}

/**
 * Load content registry from a JSON file.
 * @param {string} jsonPath - Path to JSON array of ContentPage objects
 */
export function loadRegistry(jsonPath) {
  const data = JSON.parse(readFileSync(jsonPath, 'utf-8'));
  contentRegistry = data;
}

/**
 * Get all registered content.
 * @returns {ContentPage[]}
 */
export function getContent() {
  return [...contentRegistry];
}

/**
 * Clear all registered content.
 */
export function clearContent() {
  contentRegistry = [];
}

/**
 * Generate clean Markdown file for a given content page.
 * @param {ContentPage} page
 * @returns {string} - Full Markdown content
 */
export function renderMarkdown(page) {
  const lines = [];
  // Frontmatter (AI-crawler-friendly metadata)
  lines.push('---');
  lines.push(`title: "${page.title}"`);
  lines.push(`description: "${page.description}"`);
  lines.push(`url: "${page.url}"`);
  lines.push(`category: "${page.category}"`);
  if (page.tags && page.tags.length > 0) {
    lines.push(`tags: [${page.tags.map(t => `"${t}"`).join(', ')}]`);
  }
  if (page.lastmod) {
    lines.push(`lastmod: "${page.lastmod}"`);
  }
  lines.push('---');
  lines.push('');
  // Title
  lines.push(`# ${page.title}`);
  lines.push('');
  // Description
  lines.push(page.description);
  lines.push('');
  // Body
  lines.push(page.body);
  lines.push('');
  // Footer
  lines.push('---');
  lines.push(`*Source: [${page.url}](${page.url})*`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Write all registered content as Markdown files and return the list of paths.
 * @param {string} outputDir - Base directory for Markdown output
 * @returns {string[]} - Written file paths
 */
export function writeAllMarkdown(outputDir) {
  const written = [];
  mkdirSync(outputDir, { recursive: true });
  for (const page of contentRegistry) {
    const md = renderMarkdown(page);
    const outPath = join(outputDir, page.markdownPath);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, md, 'utf-8');
    written.push(outPath);
  }
  return written;
}

/**
 * Generate an AI sitemap index of all available Markdown content.
 * @param {string} outputPath - Path for the sitemap file
 * @param {string} baseUrl - Base URL for the Markdown files
 * @returns {string} - Sitemap content
 */
export function generateSitemap(outputPath, baseUrl) {
  const lines = [
    `# AI Markdown Sitemap - ${new Date().toISOString().split('T')[0]}`,
    '',
    `# Total pages: ${contentRegistry.length}`,
    '',
    '| Title | Category | URL | Last Modified |',
    '|-------|----------|-----|---------------|',
  ];

  for (const page of contentRegistry) {
    const mdUrl = `${baseUrl.replace(/\/$/, '')}/${page.markdownPath.replace(/\\/g, '/')}`;
    const lastmod = page.lastmod || '-';
    lines.push(`| ${page.title} | ${page.category} | ${mdUrl} | ${lastmod} |`);
  }

  const sitemap = lines.join('\n') + '\n';
  if (outputPath) {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, sitemap, 'utf-8');
  }
  return sitemap;
}

/**
 * Generate or update llms.txt from the content registry.
 * @param {string} siteName - Site name
 * @param {string} siteDescription - Short site description
 * @param {object} options
 * @param {string[]} options.relatedSites - Related site URLs
 * @param {string} options.contactInfo - Contact section Markdown
 * @returns {string} - llms.txt content
 */
export function generateLlmsTxt(siteName, siteDescription, options = {}) {
  const lines = [
    `# ${siteName}`,
    '',
    `> ${siteDescription}`,
    '',
  ];

  if (options.relatedSites && options.relatedSites.length > 0) {
    lines.push('**関連サイト**: ' + options.relatedSites.join(' · '));
    lines.push('');
  }

  // Group content by category
  const byCategory = {};
  for (const page of contentRegistry) {
    const cat = page.category || 'other';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(page);
  }

  for (const [cat, pages] of Object.entries(byCategory)) {
    const catLabel = cat.charAt(0).toUpperCase() + cat.slice(1);
    lines.push(`## ${catLabel}`);
    lines.push('');
    lines.push(`| Title | Description | Link |`);
    lines.push(`|-------|-------------|------|`);
    for (const page of pages) {
      // Escape pipe characters in description
      const desc = page.description.replace(/\|/g, '\\|');
      lines.push(`| [${page.title}](${page.url}) | ${desc} | ${page.url} |`);
    }
    lines.push('');
  }

  // FAQ section
  const faqPages = contentRegistry.filter(p => p.category === 'faq');
  if (faqPages.length > 0) {
    lines.push(`## FAQ`);
    lines.push('');
    for (const faq of faqPages) {
      lines.push(`### ${faq.title}`);
      lines.push('');
      lines.push(faq.description);
      lines.push('');
      lines.push(faq.body);
      lines.push('');
    }
  }

  if (options.contactInfo) {
    lines.push(`## Contact`);
    lines.push('');
    lines.push(options.contactInfo);
    lines.push('');
  }

  lines.push('---');
  lines.push(`*最終更新: ${new Date().toISOString().split('T')[0]} | This file is for AI agents to efficiently discover site content.*`);
  lines.push('');

  return lines.join('\n');
}

/**
 * Get suggested middleware config snippet for serving Markdown to AI crawlers.
 * @returns {string} - nginx config snippet
 */
export function getMiddlewareSnippet() {
  return [
    '# Serve .md files to AI crawlers, HTML to humans',
    '# Place in server block after AI crawler detection map (ai-crawler-map.conf)',
    '',
    '# Option A: Rewrite AI crawler requests to Markdown versions',
    '# if ($ai_crawler_is_ai = 1) {',
    '#   rewrite ^(/.*?)\\.html$ /markdown$1.md break;',
    '# }',
    '',
    '# Option B: Proxy to Markdown generator endpoint',
    '# location /markdown/ {',
    '#   alias /var/www/orgiast/ai-markdown/;',
    '#   default_type text/markdown;',
    '#   add_header X-Robots-Tag "noindex";',
    '# }',
    '',
    '# Option C: Serve llms.txt and ai.txt from site root',
    'location = /llms.txt {',
    '  alias /var/www/orgiast/ai-markdown/llms.txt;',
    '  default_type text/plain;',
    '}',
    'location = /ai.txt {',
    '  alias /var/www/orgiast/ai-markdown/ai.txt;',
    '  default_type text/plain;',
    '}',
  ].join('\n') + '\n';
}

// ── CLI entry point ──
// Guard: only run when invoked directly (not when imported as module)
const validCmds = ['render', 'sitemap', 'llms', 'middleware'];
const cmd = process.argv[2] || '';
const args = process.argv.slice(3);

if (validCmds.includes(cmd)) {
  if (cmd === 'render' && args[0] && args[1]) {
  // Read source JSON, render all pages to output dir
  const jsonPath = args[0];
  const outputDir = args[1];
  loadRegistry(jsonPath);
  const files = writeAllMarkdown(outputDir);
  console.log(JSON.stringify({ written: files.length, files }, null, 2));
} else if (cmd === 'sitemap' && args[0] && args[1]) {
  const jsonPath = args[0];
  const outputPath = args[1];
  const baseUrl = args[2] || '/ai-markdown';
  loadRegistry(jsonPath);
  generateSitemap(outputPath, baseUrl);
  console.log('sitemap written to', outputPath);
} else if (cmd === 'llms' && args[0]) {
  const jsonPath = args[0];
  loadRegistry(jsonPath);
  const llms = generateLlmsTxt(
    args[1] || '株式会社オージャスト',
    '展示会ブース制作・社内イベントプロデュースを一貫提供する大阪・東京拠点のイベント制作会社',
    { relatedSites: ['https://rebooth.co.jp', 'https://event-shop.jp'] }
  );
  console.log(llms);
} else if (cmd === 'middleware') {
  console.log(getMiddlewareSnippet());
} else {
  console.log(`Usage:
  node tools/ai-markdown-gen.mjs render <registry.json> <output-dir>
      — Render all registered pages as Markdown files
  node tools/ai-markdown-gen.mjs sitemap <registry.json> <output-path> [base-url]
      — Generate AI Markdown sitemap
  node tools/ai-markdown-gen.mjs llms <registry.json> [site-name]
      — Generate llms.txt from content registry
  node tools/ai-markdown-gen.mjs middleware
      — Show nginx config snippet for AI Markdown serving`);
}
}