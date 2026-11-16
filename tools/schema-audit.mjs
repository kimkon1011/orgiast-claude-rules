// Schema.org structured data audit tool
// Fetches a URL, extracts JSON-LD, validates per schema type, outputs Markdown report
// Usage: node tools/schema-audit.mjs [url]

import process from 'node:process';
import { isEntry } from './is-entry.mjs';

const DEFAULT_URL = 'https://www.orgiast.jp';

// Validation rules per schema type
const SCHEMA_RULES = {
  Organization: { required: ['name', 'url'], recommended: ['logo', 'address', 'contactPoint', 'sameAs'] },
  LocalBusiness: { required: ['name', 'address'], recommended: ['telephone', 'openingHours', 'priceRange'] },
  WebSite: { required: ['name', 'url'], recommended: ['description', 'potentialAction'] },
  FAQPage: { required: ['mainEntity'], recommended: [] },
  Article: { required: ['headline', 'author'], recommended: ['datePublished', 'dateModified', 'image'] },
  HowTo: { required: ['name', 'step'], recommended: ['totalTime', 'estimatedCost'] },
  Project: { required: ['name'], recommended: ['description', 'url'] },
  BreadcrumbList: { required: ['itemListElement'], recommended: [] },
  Product: { required: ['name', 'description'], recommended: ['brand', 'offers', 'aggregateRating', 'category'] },
  Offer: { required: ['price', 'priceCurrency'], recommended: ['availability', 'priceValidUntil', 'url'] },
  AggregateRating: { required: ['ratingValue', 'ratingCount', 'itemReviewed'], recommended: ['bestRating', 'reviewCount'] },
  Review: { required: ['reviewBody', 'author', 'itemReviewed'], recommended: ['reviewRating', 'datePublished'] },
  Brand: { required: ['name'], recommended: ['description', 'url', 'logo', 'slogan', 'sameAs'] },
  ItemList: { required: ['name', 'itemListElement'], recommended: ['description'] },
};

function extractJsonLd(html) {
  const scripts = [];
  const regex = /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = regex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      scripts.push(parsed);
    } catch {
      scripts.push({ _parseError: true, _raw: match[1].slice(0, 200) });
    }
  }
  return scripts;
}

function normalizeSchema(obj) {
  // Handle @graph (multiple items in one script)
  if (obj['@graph']) return obj['@graph'];
  // Handle single item
  if (obj['@type']) return [obj];
  return [];
}

function validateSchema(items) {
  const results = [];
  for (const item of items) {
    const type = item['@type'];
    const rules = SCHEMA_RULES[type];
    if (!rules) {
      results.push({ type, status: 'unknown', required: [], missing: [], recommended: [] });
      continue;
    }
    const missingRequired = rules.required.filter(f => !item[f]);
    const missingRecommended = rules.recommended.filter(f => !item[f]);
    results.push({
      type,
      status: missingRequired.length === 0 ? 'pass' : 'fail',
      required: rules.required,
      missing: missingRequired,
      recommended: rules.recommended,
      missingRecommended,
    });
  }
  return results;
}

function renderReport(url, scripts, validation, error) {
  let md = `# Schema.org Audit Report\n\n`;
  md += `**URL**: ${url}\n`;
  md += `**Date**: ${new Date().toISOString().slice(0, 10)}\n\n`;

  if (error) {
    md += `## ❌ Error\n\n${error}\n\n`;
    return md;
  }

  md += `## Summary\n\n`;
  md += `- **JSON-LD scripts found**: ${scripts.length}\n`;
  md += `- **Schema items**: ${validation.reduce((s, r) => s + (r.status === 'pass' ? 1 : 0), 0)} pass, ${validation.filter(r => r.status === 'fail').length} fail, ${validation.filter(r => r.status === 'unknown').length} unknown\n\n`;

  if (scripts.length === 0) {
    md += `> ⚠️ No JSON-LD structured data found on this page.\n\n`;
    md += `### Recommended actions\n\n`;
    md += `1. Add \`Organization\` schema to \`<head>\`\n`;
    md += `2. Add \`WebSite\` schema with search action\n`;
    md += `3. Consider \`FAQPage\` for Q&A content\n`;
    md += `4. Add \`BreadcrumbList\` for navigation\n\n`;
    return md;
  }

  md += `## Detailed Results\n\n`;
  for (const v of validation) {
    const icon = v.status === 'pass' ? '✅' : v.status === 'unknown' ? '❓' : '❌';
    md += `### ${icon} ${v.type}\n\n`;
    if (v.status === 'unknown') {
      md += `Unknown schema type. No validation rules defined.\n\n`;
      continue;
    }
    if (v.missing.length > 0) {
      md += `**Missing required fields**: ${v.missing.join(', ')}\n\n`;
    } else {
      md += `All required fields present.\n\n`;
    }
    if (v.missingRecommended.length > 0) {
      md += `**Missing recommended fields**: ${v.missingRecommended.join(', ')}\n\n`;
    }
  }

  md += `## Raw JSON-LD\n\n`;
  md += '```json\n';
  md += JSON.stringify(scripts, null, 2);
  md += '\n```\n';

  return md;
}

async function audit(url) {
  let html;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    html = await resp.text();
  } catch (e) {
    return renderReport(url, [], [], `Fetch failed: ${e.message}`);
  }

  const scripts = extractJsonLd(html);
  const items = scripts.flatMap(normalizeSchema).filter(s => !s._parseError);
  const validation = validateSchema(items);
  return renderReport(url, scripts, validation, null);
}

async function main() {
  const url = process.argv[2] || DEFAULT_URL;
  const report = await audit(url);
  process.stdout.write(report);
}

if (isEntry(import.meta.url)) {
  main().catch(e => { process.stderr.write(`Error: ${e.message}\n`); process.exit(1); });
}

export { audit, extractJsonLd, normalizeSchema, validateSchema, renderReport, SCHEMA_RULES };
