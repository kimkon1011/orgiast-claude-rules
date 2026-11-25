// Semantic cache + entropy analysis + cost kill-switch.
// Offline-only: no network calls, no Anthropic/Claude models.

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function calcStructuralEntropy(text) {
  // 改行数 / 100（最大0.3）
  const newlines = Math.min((text.match(/\n/g) || []).length / 100, 0.3);
  // 箇条書き記号（-・*・1.・①等）の数 / 50（最大0.3）
  const bulletMatch = text.match(/[-・*•①-⑳]|(?<!\w)\d+\./gu);
  const bullets = Math.min((bulletMatch?.length ?? 0) / 50, 0.3);
  // 指示語の種類数 / 20（最大0.4）
  const instructionWords = ['して', 'ください', 'ください。', 'を', 'して下さい', 'お願い',
    '依頼', '指示', '命令', '条件', '必須', '要求', 'ルール', '仕様', 'TODO',
    '注意', '確認', 'チェック', '厳守', '絶対'];
  let instructionTypes = 0;
  for (const word of instructionWords) {
    if (text.includes(word)) instructionTypes++;
  }
  const instructions = Math.min(instructionTypes / 20, 0.4);
  return Math.min(newlines + bullets + instructions, 1.0);
}

/** Deterministic pseudo-random float in [-1, 1) from a seed integer. */
function pseudoRandom(seed) {
  let h = seed >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  // Map [0, 2^32) → [-1, 1) for zero-mean signed values.
  // This ensures different characters produce near-orthogonal vectors
  // while identical characters at identical positions produce identical contributions.
  return (h >>> 0) / 0x7fffffff - 1;
}

// ---------------------------------------------------------------------------
// Exported API
// ---------------------------------------------------------------------------

/**
 * Analyze the entropy (complexity) of prompt text.
 * @param {string} text
 * @returns {{ lexical: number, structural: number, combined: number }}
 */
export function analyzeEntropy(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');

  const maxLength = 100000;
  if (text.length > maxLength) return { lexical: 0, structural: 0, combined: 0 };

  // Lexical: character-level Shannon entropy after removing whitespace,
  // normalized to [0, 1) via H/(1+H) mapping.
  const chars = Array.from(text.replace(/\s+/g, ''));
  let lexical = 0;
  if (chars.length > 1) {
    const freq = {};
    for (const c of chars) freq[c] = (freq[c] || 0) + 1;
    const len = chars.length;
    let h = 0;
    for (const count of Object.values(freq)) {
      const p = count / len;
      h -= p * Math.log2(p);
    }
    // Normalize raw Shannon entropy to [0, 1): H / (1 + H)
    // This keeps short/diverse text (e.g. 'hello') in the 'simple' range.
    lexical = h / (1 + h);
  }
  // 1 char or empty → lexical stays 0 (Shannon entropy of a single symbol = 0)

  const structural = calcStructuralEntropy(text);
  const combined = lexical * 0.4 + structural * 0.6;

  return { lexical, structural, combined };
}

/**
 * Classify entropy into simple / medium / complex.
 * @param {{ combined: number }} entropy
 * @returns {'simple'|'medium'|'complex'}
 */
export function classifyEntropy(entropy) {
  if (entropy.combined < 0.3) return 'simple';
  if (entropy.combined < 0.6) return 'medium';
  return 'complex';
}

/**
 * Offline embedding: deterministic pseudo-random Float64Array(64).
 * First min(text.length, 256) characters contribute to the vector
 * via position-seeded pseudo-random values, then normalized to unit length.
 * Same text → same vector; similar prefix → similar vector.
 * @param {string} text
 * @returns {Float64Array}
 */
export function createEmbedding(text) {
  const dim = 64;
  const vec = new Float64Array(dim);
  const limit = Math.min(text.length, 256);

  // Harmonic front-weighting: each character i contributes with weight 1/(i+1).
  // This means shared prefixes naturally dominate — texts sharing first N chars
  // have cosine similarity ≈ Σ₀^{N-1} 1/(i+1)² / Σ₀^{L-1} 1/(i+1)²,
  // where L is the text length.
  for (let i = 0; i < limit; i++) {
    const code = text.charCodeAt(i);
    const weight = 1 / (i + 1);
    for (let d = 0; d < dim; d++) {
      const seed = (code * 0x9e3779b9 + i * 0x85ebca6b + d * 0xc2b2ae35) >>> 0;
      vec[d] += pseudoRandom(seed) * weight;
    }
  }

  // Normalize to unit vector so cosine similarity is meaningful
  let norm = 0;
  for (let d = 0; d < dim; d++) norm += vec[d] * vec[d];
  norm = Math.sqrt(norm);
  if (norm > 0) for (let d = 0; d < dim; d++) vec[d] /= norm;

  return vec;
}

/**
 * Cosine similarity between two Float64Array vectors.
 * @param {Float64Array|number[]} a
 * @param {Float64Array|number[]} b
 * @returns {number} 0 for zero-vector, [-1, 1] otherwise
 */
export function cosineSimilarity(a, b) {
  if (a.length !== b.length) throw new Error('Vector length mismatch');
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  if (normA === 0 || normB === 0) return 0;
  return Math.max(-1, Math.min(1, dot / (normA * normB)));
}

/**
 * Semantic cache lookup.
 * @param {string} query
 * @param {{ entries: Array<{ query, response, embedding, timestamp, ttlMs }> }} cache
 * @param {{ similarityThreshold?: number, now?: number }} [options]
 * @returns {{ hit: boolean, response?: string, similarity: number, entry?: object }}
 */
export function semanticCacheLookup(query, cache, options = {}) {
  const threshold = options.similarityThreshold ?? 0.92;
  const now = options.now ?? Date.now();
  const embedding = createEmbedding(query);

  let bestSim = -Infinity;
  let bestEntry = undefined;

  for (const entry of cache.entries) {
    if (!(now - entry.timestamp < entry.ttlMs)) continue;
    const sim = cosineSimilarity(embedding, entry.embedding);
    if (sim > bestSim) {
      bestSim = sim;
      bestEntry = entry;
    }
  }

  if (bestEntry && bestSim >= threshold) {
    return { hit: true, response: bestEntry.response, similarity: bestSim, entry: bestEntry };
  }
  return { hit: false, similarity: bestEntry ? bestSim : 0, entry: undefined, response: undefined };
}

/**
 * Store a response in the semantic cache.
 * @param {string} query
 * @param {string} response
 * @param {Float64Array} [embedding] — generated from query if omitted
 * @param {{ entries: Array }} cache
 * @param {{ maxEntries?: number, ttlMs?: number, now?: number }} [options]
 * @returns {object} the mutated cache
 */
export function semanticCacheStore(query, response, embedding, cache, options = {}) {
  const maxEntries = options.maxEntries ?? 1000;
  const ttlMs = options.ttlMs ?? 3600000;
  const now = options.now ?? Date.now();

  if (!embedding) embedding = createEmbedding(query);

  const newEntry = { query, response, embedding, timestamp: now, ttlMs };

  // Overwrite if same query (similarity >= 0.99)
  const existingIndex = cache.entries.findIndex(entry =>
    cosineSimilarity(embedding, entry.embedding) >= 0.99);
  if (existingIndex >= 0) {
    cache.entries[existingIndex] = newEntry;
  } else {
    cache.entries.push(newEntry);
  }

  // Evict oldest when exceeding maxEntries
  if (cache.entries.length > maxEntries) {
    cache.entries.sort((a, b) => a.timestamp - b.timestamp);
    cache.entries.splice(0, cache.entries.length - maxEntries);
  }

  return cache;
}

/**
 * Cost kill-switch decision.
 * @param {{ dailyCalls: number, dailyCostUsd: number, monthlyCostUsd: number, modelCostMultiplier?: number }} state
 * @param {{ maxDailyCalls: number, maxDailyCostUsd: number, maxMonthlyCostUsd: number, autoDegrade?: boolean, degradeThreshold?: number }} limits
 * @returns {{ allowed: boolean, reason: string, suggestedAction?: string }}
 */
export function costKillSwitch(state, limits) {
  if (state.dailyCalls >= limits.maxDailyCalls) {
    return { allowed: false, reason: 'daily_calls_exceeded', suggestedAction: 'stop' };
  }
  if (state.dailyCostUsd >= limits.maxDailyCostUsd) {
    return {
      allowed: false,
      reason: 'daily_cost_exceeded',
      suggestedAction: limits.autoDegrade ? 'degrade_to_cheaper' : 'stop',
    };
  }
  if (state.monthlyCostUsd >= limits.maxMonthlyCostUsd) {
    return { allowed: false, reason: 'monthly_cost_exceeded', suggestedAction: 'wait' };
  }
  if (limits.autoDegrade && limits.degradeThreshold != null) {
    const ratio = state.monthlyCostUsd / limits.maxMonthlyCostUsd;
    if (ratio >= limits.degradeThreshold) {
      return { allowed: true, reason: 'ok', suggestedAction: 'degrade_to_cheaper' };
    }
  }
  return { allowed: true, reason: 'ok', suggestedAction: undefined };
}

// Model routing pricing table (matches model-router.mjs ROUTING_TABLE).
const PRICING = {
  simple: { inputPerMillion: 0.15, outputPerMillion: 0.60 },
  medium: { inputPerMillion: 0.50, outputPerMillion: 1.50 },
  complex: { inputPerMillion: 2.50, outputPerMillion: 10.00 },
};

/**
 * Integrated entropy analysis + cache lookup + cost kill-switch + model routing.
 * @param {string} text
 * @param {{
 *   cache?: { entries: Array },
 *   costState?: object,
 *   costLimits?: object,
 *   complexModel?: string,
 *   mediumModel?: string,
 *   simpleModel?: string,
 *   similarityThreshold?: number,
 *   now?: number,
 * }} [options]
 * @returns {{
 *   route: string, model: string,
 *   entropy: { lexical: number, structural: number, combined: number },
 *   estimatedCostUsd: number,
 *   cacheHit: boolean, cacheResponse?: string,
 *   killSwitched: boolean, killSwitchAction?: string,
 * }}
 */
export function semanticRoute(text, options = {}) {
  const entropy = analyzeEntropy(text);
  const route = classifyEntropy(entropy);

  const models = {
    simple: options.simpleModel ?? 'deepseek/deepseek-v4-flash',
    medium: options.mediumModel ?? 'moonshotai/kimi-k3',
    complex: options.complexModel ?? 'openai/gpt-4o',
  };
  for (const model of Object.values(models)) {
    if (typeof model !== 'string' || !model.trim() || /anthropic|claude/i.test(model)) {
      throw new TypeError('model must be a non-empty, non-Claude model ID');
    }
  }

  let model = models[route];
  let cacheHit = false;
  let cacheResponse = undefined;
  let killSwitched = false;
  let killSwitchAction = undefined;
  let effectiveRoute = route;

  // Cache lookup
  if (options.cache) {
    const lookup = semanticCacheLookup(text, options.cache, {
      similarityThreshold: options.similarityThreshold,
      now: options.now,
    });
    if (lookup.hit) {
      cacheHit = true;
      cacheResponse = lookup.response;
    }
  }

  // Cost kill-switch
  if (options.costState && options.costLimits) {
    const ks = costKillSwitch(options.costState, options.costLimits);
    if (ks.suggestedAction === 'degrade_to_cheaper') {
      killSwitchAction = 'degrade_to_cheaper';
      // Degrade one tier
      if (effectiveRoute === 'complex') {
        effectiveRoute = 'medium';
        model = models.medium;
      } else if (effectiveRoute === 'medium') {
        effectiveRoute = 'simple';
        model = models.simple;
      }
    } else if (!ks.allowed) {
      killSwitched = true;
      killSwitchAction = ks.suggestedAction;
    }
  }

  // Estimated cost (1000 input tokens, 0 output — same basis as model-router.mjs load-test)
  const p = PRICING[effectiveRoute];
  const estimatedCostUsd = (1000 * p.inputPerMillion + 0 * p.outputPerMillion) / 1e6;

  return {
    route: effectiveRoute,
    model,
    entropy,
    estimatedCostUsd,
    cacheHit,
    cacheResponse: cacheHit ? cacheResponse : undefined,
    killSwitched,
    killSwitchAction,
  };
}
