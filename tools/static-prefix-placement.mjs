#!/usr/bin/env node
// Static prefix placement optimizer — design prompts with cache-optimized layout
// Principles:
//   1. Static (shared) content MUST go at the beginning of the prompt
//   2. Dynamic (varying) content MUST go at the end
//   3. This maximizes prefix caching, reducing both TTFT and cost
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';

// ---------- Static prefix constants ----------

/**
 * Threshold: minimum characters in a static prefix to be considered cacheable.
 * Most providers require at least ~20 tokens (~80 chars) before caching kicks in.
 */
const MIN_CACHEABLE_CHARS = 80;

/**
 * Estimate token count from character count (rough: ~4 chars per token for Japanese/English mixed).
 */
function estimateTokens(text) {
  return Math.ceil(String(text || '').length / 4);
}

function roundTo(v, decimals) {
  const m = Math.pow(10, decimals);
  return Math.round(v * m) / m;
}

// ---------- Structure definition ----------

/**
 * Define a prompt structure with static/dynamic sections.
 * @param {Array<{name:string, content:string, type:'static'|'dynamic'}>} sections
 * @returns {{sections, totalChars, staticPrefix:string, staticTokens, dynamicTokens, staticPct}}
 */
export function defineStructure(sections = []) {
  const validated = sections.map((s, i) => ({
    name: s.name || `section-${i}`,
    content: String(s.content || ''),
    type: s.type === 'dynamic' ? 'dynamic' : 'static',
  }));

  const staticParts = validated.filter(s => s.type === 'static');
  const dynamicParts = validated.filter(s => s.type === 'dynamic');
  const staticPrefix = staticParts.map(s => s.content).join('\n\n');
  const dynamicContent = dynamicParts.map(s => s.content).join('\n\n');

  const totalChars = validated.reduce((sum, s) => sum + s.content.length, 0);
  const staticTokens = estimateTokens(staticPrefix);
  const dynamicTokens = estimateTokens(dynamicContent);
  const staticPct = totalChars > 0 ? (staticPrefix.length / totalChars) * 100 : 0;

  return {
    sections: validated,
    totalChars,
    staticPrefix,
    staticPrefixChars: staticPrefix.length,
    staticTokens,
    dynamicChars: dynamicContent.length,
    dynamicTokens,
    staticPct: roundTo(staticPct, 1),
    isCacheable: staticPrefix.length >= MIN_CACHEABLE_CHARS,
  };
}

// ---------- Optimization ----------

/**
 * Optimize placement: reorder sections so static comes before dynamic.
 * Preserves original order within static and within dynamic groups.
 * @param {Array<{name:string, content:string, type:'static'|'dynamic'}>} sections
 * @returns {{original, optimized, staticPrefix, staticTokens, cacheableRatio}}
 */
export function optimizePlacement(sections = []) {
  const validated = sections.map((s, i) => ({
    name: s.name || `section-${i}`,
    content: String(s.content || ''),
    type: s.type === 'dynamic' ? 'dynamic' : 'static',
  }));

  const statics = validated.filter(s => s.type === 'static');
  const dynamics = validated.filter(s => s.type === 'dynamic');
  const optimized = [...statics, ...dynamics];

  const staticPrefix = statics.map(s => s.content).join('\n\n');
  const dynamicContent = dynamics.map(s => s.content).join('\n\n');
  const totalChars = validated.reduce((sum, s) => sum + s.content.length, 0);
  const staticTokens = estimateTokens(staticPrefix);
  const dynamicTokens = estimateTokens(dynamicContent);

  // Preserve all content: verify no data loss
  const originalTotal = validated.reduce((sum, s) => sum + s.content.length, 0);
  const optimizedTotal = optimized.reduce((sum, s) => sum + s.content.length, 0);
  const allContentPreserved = originalTotal === optimizedTotal;

  const cacheableRatio = totalChars > 0 ? roundTo((staticPrefix.length / totalChars) * 100, 1) : 0;

  return {
    original: validated,
    optimized,
    staticPrefix,
    staticPrefixChars: staticPrefix.length,
    staticTokens,
    dynamicChars: dynamicContent.length,
    dynamicTokens,
    cacheableRatio,
    allContentPreserved,
    isCacheable: staticPrefix.length >= MIN_CACHEABLE_CHARS,
  };
}

// ---------- Cache hit estimation ----------

/**
 * Estimate cache hit ratio and performance gains from static prefix placement.
 * Uses empirically derived constants from X-0009 bench results:
 *   - First-request TTFT (cold): ~3200ms for booth proposal workload
 *   - Subsequent TTFT (cached): ~600ms (82.8% reduction with full prefix match)
 *
 * @param {number} staticTokens — number of tokens in the shared static prefix
 * @param {number} dynamicTokens — number of tokens in the variable suffix
 * @param {number} requestCount — how many requests share this prefix (1 = single)
 * @returns {{cacheHitRatio, expectedTtftFirst, expectedTtftSubsequent, ttftReductionPct, costSavingsPct}}
 */
export function estimateCacheHit(staticTokens = 0, dynamicTokens = 0, requestCount = 1) {
  if (staticTokens <= 0 || requestCount <= 1) {
    return {
      cacheHitRatio: 0,
      expectedTtftFirst: 3200,
      expectedTtftSubsequent: 0,
      ttftReductionPct: 0,
      costSavingsPct: 0,
    };
  }

  // Cache hit ratio = static / total tokens (proportion of prefix that can be cached)
  const totalTokens = staticTokens + dynamicTokens;
  const cacheHitRatio = totalTokens > 0 ? roundTo(staticTokens / totalTokens, 4) : 0;

  // TTFT estimation (based on X-0009 empirical data)
  const expectedTtftFirst = Math.max(800, Math.round(800 + (staticTokens * 4))); // cold: ~800ms base + 4ms/token
  const expectedTtftSubsequent = requestCount > 1
    ? Math.max(200, Math.round(expectedTtftFirst * 0.18)) // cached: ~18% of cold (82.8% reduction)
    : 0;
  const ttftReductionPct = expectedTtftFirst > 0
    ? roundTo((1 - expectedTtftSubsequent / expectedTtftFirst) * 100, 1)
    : 0;

  // Cost savings: cached tokens are ~90% cheaper (OpenRouter pricing)
  // First request: all tokens at full price
  // Subsequent requests (count-1): static tokens at 10% price, dynamic at full price
  const fullPricePerToken = 0.15 / 1_000_000; // $0.15/1M tokens
  const cachedPricePerToken = 0.015 / 1_000_000; // $0.015/1M tokens (90% off)
  const costAllFull = (staticTokens + dynamicTokens) * requestCount * fullPricePerToken;
  const costWithCache = (
    // First request: all tokens full price
    (staticTokens + dynamicTokens) * fullPricePerToken
    // Subsequent requests: static at cached price, dynamic at full price
    + (requestCount - 1) * (staticTokens * cachedPricePerToken + dynamicTokens * fullPricePerToken)
  );
  const costSavingsPct = costAllFull > 0
    ? roundTo((1 - costWithCache / costAllFull) * 100, 1)
    : 0;

  return {
    cacheHitRatio,
    expectedTtftFirst,
    expectedTtftSubsequent,
    ttftReductionPct,
    costSavingsPct,
  };
}

// ---------- Template generation ----------

/**
 * Generate a formatted prompt template with visual section separation.
 * @param {Array<{name:string, content:string, type:'static'|'dynamic'}>} sections
 * @returns {string} formatted template
 */
export function generateTemplate(sections = []) {
  if (!sections || sections.length === 0) return '';

  const result = optimizePlacement(sections);
  const lines = [];

  if (!result.isCacheable) {
    lines.push('// WARNING: Static prefix is too short to benefit from caching.');
    lines.push(`// Current length: ${result.staticPrefixChars} chars (minimum: ${MIN_CACHEABLE_CHARS} chars)`);
    lines.push(`// Consider merging these sections or adding more shared content.\n`);
  }

  const statics = result.optimized.filter(s => s.type === 'static');
  const dynamics = result.optimized.filter(s => s.type === 'dynamic');

  lines.push('╔══════════════════════════════════════╗');
  lines.push('║  STATIC PREFIX (CACHEABLE)          ║');
  lines.push(`║  ~${result.staticTokens} tokens, ${result.cacheableRatio}% of total    ║`);
  lines.push('╚══════════════════════════════════════╝');
  lines.push('');

  for (const s of statics) {
    lines.push(`--- ${s.name} ---`);
    lines.push(s.content);
    lines.push('');
  }

  if (dynamics.length > 0) {
    lines.push('╔══════════════════════════════════════╗');
    lines.push('║  DYNAMIC SECTIONS (NOT CACHED)      ║');
    lines.push(`║  ~${result.dynamicTokens} tokens remaining               ║`);
    lines.push('╚══════════════════════════════════════╝');
    lines.push('');

    for (const s of dynamics) {
      lines.push(`--- ${s.name} ---`);
      lines.push(s.content);
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ---------- Booth template ----------

/**
 * Orgiast-specific booth design prompt template.
 * Returns a pre-built structure optimized for prefix caching.
 * @returns {Array<{name, content, type}>}
 */
export function boothTemplate() {
  return [
    {
      name: 'role-definition',
      content: 'あなたは展示会ブースのプロジェクトマネージャー兼デザイナーです。以下のデザインガイドラインに従って提案を生成してください。常に安全基準を最優先し、クライアントの予算・要望に合わせた現実的な提案を行います。',
      type: 'static',
    },
    {
      name: 'booth-standard-specs',
      content: `【標準小間仕様】
- サイズ: 2.7m×6m（1小間）
- パネル高さ: 最大2.5m（天吊り不可）
- 構造材: アルミフレーム（パイプ径28mm/48mm）
- 床材: 標準グレーカーペット（グレードA）
- 壁材: 白色パネル（塗装可能）
- 照明: LEDスポットライト（100W相当）×4基まで標準
- 電気容量: 1小間あたり標準15A`,
      type: 'static',
    },
    {
      name: 'safety-rules',
      content: `【安全基準・遵守事項】
- 通路側への展示物のはみ出し禁止（通路幅基準遵守）
- 火気使用禁止（調理実演を除く計画届出必須）
- 高さ3m以上の什器使用時は転倒防止措置
- 搬入出時間は展示会規定に従う
- 養生・床保護必須`,
      type: 'static',
    },
    {
      name: 'common-materials',
      content: `【標準備品・材材】
- テーブル: 900×450mm（折りたたみ・クロス付）
- チェア: フォールディングチェア×2
- ゴミ箱: 標準サイズ×1
- パンフレットラック: A4対応×2`,
      type: 'static',
    },
    {
      name: 'company-info',
      content: '【制作会社情報】株式会社オージャスト / Re:ブース（リユースブース専門ブランド）。環境配慮型展示ブースの提案・制作・運用をワンストップで提供。SDGs対応・コスト削減・短期納品が強み。',
      type: 'static',
    },
    {
      name: 'case-name',
      content: '【案件名】{{ CASE_NAME }}',
      type: 'dynamic',
    },
    {
      name: 'exhibition-details',
      content: `【展示会情報】
- 展示会名: {{ EXHIBITION_NAME }}
- 会期: {{ DATES }}
- 会場: {{ VENUE }}
- ブース番号: {{ BOOTH_NUMBER }}
- 小間数: {{ KOMA_COUNT }}`,
      type: 'dynamic',
    },
    {
      name: 'company-profile',
      content: `【出展企業情報】
- 企業名: {{ COMPANY_NAME }}
- 業種: {{ INDUSTRY }}
- ブース目的: {{ PURPOSE }}
- 予算範囲: {{ BUDGET_RANGE }}`,
      type: 'dynamic',
    },
    {
      name: 'special-requirements',
      content: `【特別要件】
- 追加オプション: {{ OPTIONS }}
- デザインテイスト: {{ DESIGN_STYLE }}
- 特記事項: {{ NOTES }}`,
      type: 'dynamic',
    },
  ];
}

// ---------- Demo / benchmark ----------

/**
 * Run demo: compare 3 placement strategies.
 * @returns {{scenarios: Array<{name, staticPct, cacheHitRatio, ttftReduction, costSavings, isCacheable}>}}
 */
export function demo() {
  const scenarios = [];

  // Scenario 1: Worst — dynamic content first
  {
    const sections = [
      { name: 'case-name', content: '案件A のブース提案を生成', type: 'dynamic' },
      { name: 'exhibition-details', content: '2026年12月 東京ビッグサイト 小間1-097', type: 'dynamic' },
      { name: 'booth-standard-specs', content: '【標準小間仕様】2.7m×6m パネル高2.5m アルミフレーム LED照明×4基', type: 'static' },
      { name: 'safety-rules', content: '【安全基準】通路確保 火気禁止 転倒防止', type: 'static' },
      { name: 'company-info', content: '株式会社オージャスト / Re:ブース', type: 'static' },
    ];
    const result = defineStructure(sections);
    const cache = estimateCacheHit(result.staticTokens, result.dynamicTokens, 3);
    scenarios.push({
      name: 'worst (dynamic first)',
      staticPct: result.staticPct,
      cacheHitRatio: cache.cacheHitRatio,
      ttftReduction: cache.ttftReductionPct,
      costSavings: cache.costSavingsPct,
      isCacheable: result.isCacheable,
    });
  }

  // Scenario 2: Mixed — interleaved static/dynamic
  {
    const sections = [
      { name: 'role-definition', content: 'あなたは展示会ブースのプロジェクトマネージャー兼デザイナーです。', type: 'static' },
      { name: 'case-name', content: '案件A のブース提案を生成', type: 'dynamic' },
      { name: 'booth-standard-specs', content: '【標準小間仕様】2.7m×6m パネル高2.5m アルミフレーム LED照明×4基', type: 'static' },
      { name: 'exhibition-details', content: '2026年12月 東京ビッグサイト 小間1-097', type: 'dynamic' },
      { name: 'safety-rules', content: '【安全基準】通路確保 火気禁止 転倒防止', type: 'static' },
      { name: 'company-info', content: '株式会社オージャスト / Re:ブース', type: 'static' },
      { name: 'special-requirements', content: '特別要件: 天吊り看板 高所作業あり', type: 'dynamic' },
    ];
    const result = defineStructure(sections);
    const optimized = optimizePlacement(sections);
    const cache = estimateCacheHit(optimized.staticTokens, optimized.dynamicTokens, 3);
    scenarios.push({
      name: 'mixed (interleaved)',
      staticPct: result.staticPct,
      cacheHitRatio: cache.cacheHitRatio,
      ttftReduction: cache.ttftReductionPct,
      costSavings: cache.costSavingsPct,
      isCacheable: result.isCacheable,
    });
  }

  // Scenario 3: Optimized — static first, dynamic last
  {
    const sections = boothTemplate().map(s => ({
      name: s.name,
      content: s.content,
      type: s.type,
    }));
    const result = defineStructure(sections);
    const cache = estimateCacheHit(result.staticTokens, result.dynamicTokens, 3);
    scenarios.push({
      name: 'optimized (static first)',
      staticPct: result.staticPct,
      cacheHitRatio: cache.cacheHitRatio,
      ttftReduction: cache.ttftReductionPct,
      costSavings: cache.costSavingsPct,
      isCacheable: result.isCacheable,
    });
  }

  return { scenarios };
}

// ---------- CLI ----------

function printAnalysis(sections) {
  const result = defineStructure(sections);
  const opt = optimizePlacement(sections);

  console.log('=== Static Prefix Placement Analysis ===\n');
  console.log(`Total length:     ${result.totalChars} chars`);
  console.log(`Static prefix:    ${result.staticPrefixChars} chars (${result.staticPct}%)`);
  console.log(`Static tokens:    ${result.staticTokens}`);
  console.log(`Dynamic tokens:   ${result.dynamicTokens}`);
  console.log(`Cacheable:        ${result.isCacheable}`);
  console.log(`All content kept: ${opt.allContentPreserved}`);
  console.log('');

  // Per-section breakdown
  console.log('Section breakdown:');
  for (const s of result.sections) {
    const marker = s.type === 'static' ? '[STATIC]' : '[DYNAMIC]';
    console.log(`  ${markER} ${s.name}: ${s.content.length} chars`);
  }
  console.log('');

  // Cache estimation for 3 requests
  console.log('Cache estimate (3 requests):');
  const cache = estimateCacheHit(opt.staticTokens, opt.dynamicTokens, 3);
  console.log(`  Cache hit ratio:   ${(cache.cacheHitRatio * 100).toFixed(1)}%`);
  console.log(`  TTFT (first):      ${cache.expectedTtftFirst}ms`);
  console.log(`  TTFT (subsequent): ${cache.expectedTtftSubsequent}ms`);
  console.log(`  TTFT reduction:    ${cache.ttftReductionPct}%`);
  console.log(`  Cost savings:     ${cache.costSavingsPct}%`);
}

if (isEntry(import.meta.url)) {
  const args = process.argv.slice(2);

  if (args.includes('--demo')) {
    const result = demo();
    console.log(JSON.stringify(result, null, 2));
  } else if (args.includes('--analyze')) {
    const idx = args.indexOf('--analyze');
    const inputFile = idx + 1 < args.length && !args[idx + 1].startsWith('--') ? args[idx + 1] : '';
    if (!inputFile) {
      console.error('Usage: node tools/static-prefix-placement.mjs --analyze <sections.json>');
      process.exitCode = 1;
    } else {
      const sections = JSON.parse(fs.readFileSync(path.resolve(inputFile), 'utf8'));
      printAnalysis(sections);
    }
  } else if (args.includes('--generate')) {
    const template = generateTemplate(boothTemplate());
    console.log(template);
  } else if (args.includes('--benchmark')) {
    const sections = boothTemplate();
    const result = defineStructure(sections);
    const opt = optimizePlacement(sections);

    console.log('# Static Prefix Placement — Benchmark Report\n');
    console.log(`Date: ${new Date().toISOString().split('T')[0]}`);
    console.log('Tool: tools/static-prefix-placement.mjs\n');

    console.log('## Structure\n');
    console.log(`| Metric | Value |`);
    console.log('|---|---|');
    console.log(`| Total sections | ${sections.length} (${sections.filter(s => s.type === 'static').length} static / ${sections.filter(s => s.type === 'dynamic').length} dynamic) |`);
    console.log(`| Static prefix | ${result.staticPrefixChars} chars (${result.staticPct}%) |`);
    console.log(`| Static tokens | ${result.staticTokens} |`);
    console.log(`| Dynamic tokens | ${result.dynamicTokens} |`);
    console.log(`| Cacheable | ${result.isCacheable} |`);
    console.log(`| Content preserved | ${opt.allContentPreserved} |`);
    console.log('');

    console.log('## Cache Efficiency (projections)\n');
    console.log('| Requests | TTFT first | TTFT subsequent | Reduction | Cost savings |');
    console.log('|---|---|---|---|');
    for (const n of [1, 2, 3, 5, 10]) {
      const cache = estimateCacheHit(result.staticTokens, result.dynamicTokens, n);
      console.log(`| ${n} | ${cache.expectedTtftFirst}ms | ${n > 1 ? `${cache.expectedTtftSubsequent}ms` : 'N/A'} | ${n > 1 ? `${cache.ttftReductionPct}%` : '0%'} | ${cache.costSavingsPct}% |`);
    }
    console.log('');

    console.log('## Scenario Comparison\n');
    const demoResult = demo();
    console.log('| Scenario | Static % | Cache hit | TTFT reduction | Cost savings |');
    console.log('|---|---|---|---|');
    for (const s of demoResult.scenarios) {
      const hitPct = s.cacheHitRatio !== undefined ? `${(s.cacheHitRatio * 100).toFixed(1)}%` : '—';
      console.log(`| ${s.name} | ${s.staticPct}% | ${hitPct} | ${s.ttftReduction}% | ${s.costSavings}% |`);
    }
  } else {
    console.log(`Static Prefix Placement Tool

使い方:
  node tools/static-prefix-placement.mjs --demo
  node tools/static-prefix-placement.mjs --analyze <sections.json>
  node tools/static-prefix-placement.mjs --generate
  node tools/static-prefix-placement.mjs --benchmark

オプション:
  --demo              配置戦略比較デモ (worst / mixed / optimized)
  --analyze <file>    プロンプト構造JSONを分析
  --generate          オージャストブース提案用テンプレートを生成
  --benchmark         ベンチマークレポートを出力
`);
  }
}