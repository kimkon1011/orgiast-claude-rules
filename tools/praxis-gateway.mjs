// Praxis-style AI gateway: static prefix caching, body-based routing, provider translation, token accounting.
// Offline-only: no network calls, no Anthropic/Claude models.
// Loosely models Red Hat EnMaaS (Praxis + llm-d + vLLM) architecture for cost-benefit estimation.

// ---------------------------------------------------------------------------
// Pricing table (same structure as model-router.mjs ROUTING_TABLE)
// ---------------------------------------------------------------------------
export const ROUTING_TABLE = Object.freeze({
  frontier:   { inputPerMillion: 10.00, outputPerMillion: 40.00 }, // GPT-6 Luna / Fable class
  medium:     { inputPerMillion:  2.50, outputPerMillion: 10.00 }, // Sonnet / GPT-5 class
  economy:    { inputPerMillion:  0.15, outputPerMillion:  0.60 }, // DeepSeek Flash / Haiku
  batch:      { inputPerMillion:  0.08, outputPerMillion:  0.30 }, // Batch API (50% off economy)
});

export const ROUTE_NAMES = Object.keys(ROUTING_TABLE);

// Default static prefix patterns for Orgiast booth-production use cases.
// Prefixes are matched by longest-prefix substring: the first N characters of
// input_text that contain a cached prefix string.
export const DEFAULT_PREFIXES = [
  { name: 'company_profile',     pattern: '会社概要',            model: 'economy',  ttlSec: 300 },
  { name: 'past_case',           pattern: '過去事例',            model: 'economy',  ttlSec: 300 },
  { name: 'event_template',      pattern: 'イベント進行台本',    model: 'medium',   ttlSec: 600 },
  { name: 'spec_template',       pattern: '仕様テンプレート',    model: 'medium',   ttlSec: 600 },
  { name: 'safety_standard',     pattern: '安全基準',            model: 'economy',  ttlSec: 900 },
  { name: 'construction_plan',   pattern: '施工計画書',          model: 'medium',   ttlSec: 900 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function splitPrefix(text, prefix) {
  const idx = text.indexOf(prefix);
  if (idx === -1) return null;
  return { prefix, remaining: text.slice(idx + prefix.length), prefixEnd: idx + prefix.length };
}

function checkRoute(route) {
  if (!ROUTE_NAMES.includes(route)) throw new Error(`Invalid route "${route}"; must be one of: ${ROUTE_NAMES.join(', ')}`);
}

function validateTokens(tokens) {
  if (typeof tokens === 'number') {
    if (!Number.isSafeInteger(tokens) || tokens < 0) throw new Error('Token count must be a non-negative integer');
    return { input: tokens, output: 0 };
  }
  if (!tokens || !Number.isSafeInteger(tokens.input) || tokens.input < 0
    || !Number.isSafeInteger(tokens.output) || tokens.output < 0) throw new Error('Tokens must be non-negative integers: number or {input, output}');
  return tokens;
}

// ---------------------------------------------------------------------------
// 1. Static prefix matching
// ---------------------------------------------------------------------------

/**
 * Match input text against static prefix patterns.
 * Returns the longest matching prefix (by matched-character length).
 *
 * @param {string} text - The full prompt text to match against.
 * @param {Array<{name:string, pattern:string, model?:string, ttlSec?:number}>} [prefixes]
 *   - Defaults to DEFAULT_PREFIXES.
 * @returns {{ matched: boolean, prefix: object|null, remaining: string,
 *             cachedLength: number, route: string }}
 */
export function staticPrefixMatch(text, prefixes = DEFAULT_PREFIXES) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');

  let best = null;
  let bestLen = 0;
  for (const p of prefixes) {
    const result = splitPrefix(text, p.pattern);
    if (result && p.pattern.length > bestLen) {
      best = { ...p, ...result };
      bestLen = p.pattern.length;
    }
  }
  if (!best) {
    return { matched: false, prefix: null, remaining: text, cachedLength: 0, route: 'medium' };
  }
  return {
    matched: true,
    prefix: best,
    remaining: best.remaining.trim(),
    cachedLength: bestLen,
    route: best.model || 'medium',
  };
}

// ---------------------------------------------------------------------------
// 2. Body-based routing
// ---------------------------------------------------------------------------

/**
 * Body-based routing: analyse prompt content and determine the best route.
 * Static prefix detection is evaluated first; if no prefix matches,
 * the text is classified by keyword analysis (similar to model-router).
 *
 * @param {string} text - The full prompt text to route.
 * @param {object} [options]
 * @param {Array}   [options.prefixes] - Custom prefixes (defaults to DEFAULT_PREFIXES).
 * @param {boolean} [options.enablePrefixCache=true] - Whether to attempt prefix matching.
 * @returns {{ route: string, model: string, prefixMatched: boolean,
 *             prefixSaved: number, prefixName: string|null,
 *             costInputUsd: number, costOutputUsd: number,
 *             estimatedCostUsd: number }}
 */
export function bodyRoute(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');

  const { prefixes = DEFAULT_PREFIXES, enablePrefixCache = true } = options;

  // Phase 1: Static prefix matching
  let prefixMatched = false;
  let prefixSaved = 0;
  let prefixName = null;
  let route = 'medium';
  let remaining = text;

  if (enablePrefixCache) {
    const match = staticPrefixMatch(text, prefixes);
    if (match.matched) {
      prefixMatched = true;
      prefixSaved = match.cachedLength;
      prefixName = match.prefix.name;
      route = match.route;
      remaining = match.remaining;
    }
  }

  // Phase 2: If no prefix, body-based classification
  if (!prefixMatched) {
    route = classifyBodyRoute(text);
  }

  checkRoute(route);

  // Phase 3: Cost estimation
  const pricing = ROUTING_TABLE[route];
  // Estimate ~3× output tokens for a typical response at this routing tier
  const inputTokens = Math.ceil(remaining.length / 4) || 10;  // ~4 chars per token for JP
  const outputTokens = Math.ceil(inputTokens * 3);
  const costInputUsd = (inputTokens * pricing.inputPerMillion) / 1_000_000;
  const costOutputUsd = (outputTokens * pricing.outputPerMillion) / 1_000_000;

  return {
    route,
    model: routeModel(route),
    prefixMatched,
    prefixSaved,
    prefixName,
    inputTokens,
    outputTokens,
    costInputUsd: +costInputUsd.toFixed(8),
    costOutputUsd: +costOutputUsd.toFixed(8),
    estimatedCostUsd: +(costInputUsd + costOutputUsd).toFixed(8),
  };
}

/**
 * Classify text body to determine routing based on content.
 * Uses keyword heuristics (similar to model-router.mjs classifyTask).
 *
 * @param {string} text
 * @returns {'frontier'|'medium'|'economy'|'batch'}
 */
export function classifyBodyRoute(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (text.length > 100_000) return 'medium';  // fallback for oversized

  // Frontier: creative design, strategy, architecture
  const frontier = /設計|創造|創作|アーキテクチャ|戦略|コンセプト|トレードオフ|企画方針|ブース構想|\b(design|architecture|creative|strategy|concept)\b/i;
  if (frontier.test(text)) return 'frontier';

  // Economy: simple Q&A, extraction, classification, template filling
  const economy = /分類|抽出|抜き出|要約|定型|テンプレート|簡単|単純|\b(classify|extract|summarize|template)\b/i;
  if (economy.test(text)) return 'economy';

  // Batch: large-scale batch processing indicators
  const batch = /大量|一括|バッチ|全件|全行|\b(batch|bulk|all)\b/i;
  if (batch.test(text)) return 'batch';

  return 'medium';
}

// ---------------------------------------------------------------------------
// 3. Provider translation (mock)
// ---------------------------------------------------------------------------

/**
 * Translate a request body between API provider formats.
 * Provides structural conversion; actual fields are illustrative.
 *
 * Supported providers: 'openai', 'anthropic', 'chat-completions'.
 *
 * @param {object} body - Request body in source format.
 * @param {'openai'|'anthropic'|'chat-completions'} from
 * @param {'openai'|'anthropic'|'chat-completions'} to
 * @returns {object} Transformed body in target format.
 */
export function translateRequest(body, from, to) {
  if (!body || typeof body !== 'object') throw new TypeError('body must be an object');
  const validProviders = ['openai', 'anthropic', 'chat-completions'];
  if (!validProviders.includes(from)) throw new Error(`Unknown source provider "${from}"`);
  if (!validProviders.includes(to)) throw new Error(`Unknown target provider "${to}"`);
  if (from === to) return { ...body };

  // OpenAI Messages → Anthropic Messages
  if (from === 'openai' && to === 'anthropic') {
    const messages = body.messages || [];
    const systemMsg = messages.find(m => m.role === 'system');
    return {
      model: body.model,
      max_tokens: body.max_tokens || 1024,
      system: systemMsg?.content || '',
      messages: messages.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    };
  }

  // Anthropic Messages → OpenAI Messages
  if (from === 'anthropic' && to === 'openai') {
    const msgs = [];
    if (body.system) msgs.push({ role: 'system', content: body.system });
    if (body.messages) msgs.push(...body.messages.map(m => ({ role: m.role, content: m.content })));
    return {
      model: body.model,
      max_tokens: body.max_tokens || 1024,
      messages: msgs,
    };
  }

  // OpenAI → Chat Completions (identity + extra fields)
  if (from === 'openai' && to === 'chat-completions') {
    return { ...body, provider: 'openai', gateway: 'praxis' };
  }

  // Anthropic → Chat Completions
  if (from === 'anthropic' && to === 'chat-completions') {
    const msgs = [];
    if (body.system) msgs.push({ role: 'system', content: body.system });
    if (body.messages) msgs.push(...body.messages.map(m => ({ role: m.role, content: m.content })));
    return { model: body.model, messages: msgs, max_tokens: body.max_tokens, provider: 'anthropic', gateway: 'praxis' };
  }

  // Chat Completions → OpenAI
  if (from === 'chat-completions' && to === 'openai') {
    const { provider: _p, gateway: _g, ...rest } = body;
    return rest;
  }

  // Chat Completions → Anthropic
  if (from === 'chat-completions' && to === 'anthropic') {
    const msgs = body.messages || [];
    const systemMsg = msgs.find(m => m.role === 'system');
    return {
      model: body.model,
      max_tokens: body.max_tokens || 1024,
      system: systemMsg?.content || '',
      messages: msgs.filter(m => m.role !== 'system').map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
    };
  }

  throw new Error(`Translation from "${from}" to "${to}" is not implemented`);
}

// ---------------------------------------------------------------------------
// 4. Token accounting
// ---------------------------------------------------------------------------

/**
 * Token accounting: record and aggregate token usage across models/tasks/users.
 *
 * @param {Array<{ model:string, route?:string, task?:string, user?:string,
 *                 inputTokens:number, outputTokens:number, timestamp?:number }>} log
 * @param {object} [options]
 * @param {Array<string>} [options.groupBy=['model','route']] - Aggregation dimensions.
 * @returns {{ rows: Array<object>, totals: { calls:number, inputTokens:number,
 *            outputTokens:number, costUsd:number }, table: string }}
 */
export function tokenAccounting(log, options = {}) {
  if (!Array.isArray(log)) throw new TypeError('log must be an array');
  const { groupBy = ['model', 'route'] } = options;
  const validKeys = ['model', 'route', 'task', 'user'];
  for (const key of groupBy) {
    if (!validKeys.includes(key)) throw new Error(`Invalid groupBy key "${key}"`);
  }

  // Aggregate
  const groups = {};
  for (const entry of log) {
    if (typeof entry.inputTokens !== 'number' || typeof entry.outputTokens !== 'number') {
      throw new Error('Each entry must have numeric inputTokens and outputTokens');
    }
    const dims = groupBy.map(k => entry[k] || '(unknown)');
    const key = dims.join('::');
    if (!groups[key]) {
      groups[key] = { ...Object.fromEntries(groupBy.map((k, i) => [k, dims[i]])), calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    }
    const g = groups[key];
    g.calls++;
    g.inputTokens += entry.inputTokens;
    g.outputTokens += entry.outputTokens;
    const route = entry.route || 'medium';
    const pricing = ROUTING_TABLE[route];
    if (pricing) {
      g.costUsd += (entry.inputTokens * pricing.inputPerMillion + entry.outputTokens * pricing.outputPerMillion) / 1_000_000;
    }
  }

  const rows = Object.values(groups).sort((a, b) => b.costUsd - a.costUsd);

  // Totals
  const totals = { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const row of rows) {
    totals.calls += row.calls;
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.costUsd += row.costUsd;
  }
  totals.costUsd = +totals.costUsd.toFixed(6);

  // Format table
  const header = `${groupBy.join(' | ')} | Calls | Input Tokens | Output Tokens | Cost USD`;
  const sep = '|---|---|---:|---:|---:|';
  const lines = rows.map(r => {
    const dims = groupBy.map(k => r[k]).join(' | ');
    return `${dims} | ${r.calls} | ${r.inputTokens.toLocaleString()} | ${r.outputTokens.toLocaleString()} | $${r.costUsd.toFixed(6)}`;
  });
  const table = [header, sep, ...lines].join('\n');

  return { rows, totals, table };
}

// ---------------------------------------------------------------------------
// 5. Cost estimation & reduction simulator
// ---------------------------------------------------------------------------

/**
 * Simulate cost reduction from deploying static prefix caching + body-based routing.
 *
 * @param {object} traffic
 * @param {number} traffic.prompts     - Prompts per month.
 * @param {number} traffic.avgInputTk  - Average input tokens per prompt.
 * @param {number} traffic.avgOutputTk - Average output tokens per prompt.
 * @param {object} [config]
 * @param {'frontier'|'medium'} [config.baselineRoute='frontier'] - Baseline model route before optimisation.
 * @param {number} [config.cacheableRatio=0.6]   - Fraction of prompts matching a static prefix.
 * @param {number} [config.rerouteFraction=0.5]   - Fraction of non-cacheable prompts eligible for economy routing.
 * @param {number} [config.avgPrefixRatio=0.4]    - Average fraction of input tokens saved by prefix cache.
 * @returns {{ baselineMonthlyUsd: number, optimizedMonthlyUsd: number,
 *            savingsUsd: number, reductionPercent: number,
 *            breakpoints: object }}
 */
export function estimateCostReduction(traffic, config = {}) {
  const { prompts = 1000, avgInputTk = 2000, avgOutputTk = 4000 } = traffic;
  const {
    baselineRoute = 'frontier',
    cacheableRatio = 0.6,
    rerouteFraction = 0.5,
    avgPrefixRatio = 0.4,
  } = config;

  if (prompts < 1 || avgInputTk < 1 || avgOutputTk < 1) throw new Error('Traffic values must be positive');
  if (cacheableRatio < 0 || cacheableRatio > 1) throw new Error('cacheableRatio must be in [0, 1]');
  if (rerouteFraction < 0 || rerouteFraction > 1) throw new Error('rerouteFraction must be in [0, 1]');
  if (avgPrefixRatio < 0 || avgPrefixRatio > 1) throw new Error('avgPrefixRatio must be in [0, 1]');

  checkRoute(baselineRoute);
  const basePrice = ROUTING_TABLE[baselineRoute];

  // Baseline: all traffic at baseline route
  const baseInputTk = prompts * avgInputTk;
  const baseOutputTk = prompts * avgOutputTk;
  const baselineMonthlyUsd =
    (baseInputTk * basePrice.inputPerMillion + baseOutputTk * basePrice.outputPerMillion) / 1_000_000;

  // Optimised:
  //   cacheable: prefix → economy route, input tokens reduced by avgPrefixRatio
  //   non-cacheable, rerouted: economy route (full input+output)
  //   non-cacheable, kept: baseline route (full input+output)
  const cached = prompts * cacheableRatio;
  const nonCached = prompts - cached;
  const rerouted = nonCached * rerouteFraction;
  const kept = nonCached - rerouted;

  const economyPrice = ROUTING_TABLE.economy;

  const cachedCost =
    (cached * (avgInputTk * (1 - avgPrefixRatio)) * economyPrice.inputPerMillion
     + cached * avgOutputTk * economyPrice.outputPerMillion) / 1_000_000;

  const reroutedCost =
    (rerouted * avgInputTk * economyPrice.inputPerMillion
     + rerouted * avgOutputTk * economyPrice.outputPerMillion) / 1_000_000;

  const keptCost =
    (kept * avgInputTk * basePrice.inputPerMillion
     + kept * avgOutputTk * basePrice.outputPerMillion) / 1_000_000;

  const optimizedMonthlyUsd = cachedCost + reroutedCost + keptCost;
  const savingsUsd = baselineMonthlyUsd - optimizedMonthlyUsd;
  const reductionPercent = baselineMonthlyUsd > 0 ? (savingsUsd / baselineMonthlyUsd) * 100 : 0;

  // Breakpoints for different ratios (computed inline, no recursion)
  const breakpoints = {};
  const bpBaselineCost = baselineMonthlyUsd;
  for (const ratio of [0.3, 0.5, 0.7, 0.9]) {
    const bpCached = prompts * ratio;
    const bpNonCached = prompts - bpCached;
    const bpRerouted = bpNonCached * rerouteFraction;
    const bpKept = bpNonCached - bpRerouted;
    const bpCachedCost =
      (bpCached * (avgInputTk * (1 - avgPrefixRatio)) * economyPrice.inputPerMillion
       + bpCached * avgOutputTk * economyPrice.outputPerMillion) / 1_000_000;
    const bpReroutedCost =
      (bpRerouted * avgInputTk * economyPrice.inputPerMillion
       + bpRerouted * avgOutputTk * economyPrice.outputPerMillion) / 1_000_000;
    const bpKeptCost =
      (bpKept * avgInputTk * basePrice.inputPerMillion
       + bpKept * avgOutputTk * basePrice.outputPerMillion) / 1_000_000;
    const bpOpt = bpCachedCost + bpReroutedCost + bpKeptCost;
    const bpSavings = bpBaselineCost - bpOpt;
    breakpoints[`cacheable_${Math.round(ratio * 100)}pct`] = {
      reductionPercent: bpBaselineCost > 0 ? +((bpSavings / bpBaselineCost) * 100).toFixed(1) : 0,
      savingsUsd: +bpSavings.toFixed(6),
    };
  }

  return {
    baselineMonthlyUsd: +baselineMonthlyUsd.toFixed(6),
    optimizedMonthlyUsd: +optimizedMonthlyUsd.toFixed(6),
    savingsUsd: +savingsUsd.toFixed(6),
    reductionPercent: +reductionPercent.toFixed(1),
    breakpoints,
  };
}

// ---------------------------------------------------------------------------
// Internal: model name for a given route
// ---------------------------------------------------------------------------
function routeModel(route) {
  const models = {
    frontier: 'openai/gpt-6-luna',
    medium: 'moonshotai/kimi-k3',
    economy: 'deepseek/deepseek-v4-flash',
    batch: 'openai/batch-gpt-4o',
  };
  return models[route] || 'unknown';
}

// ---------------------------------------------------------------------------
// Unit-test helpers
// ---------------------------------------------------------------------------

/** @package */
export function __testing() {
  return { splitPrefix, routeModel };
}