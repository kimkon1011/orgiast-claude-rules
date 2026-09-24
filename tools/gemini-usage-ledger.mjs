// Source: https://ai.google.dev/gemini-api/docs/pricing ; verified 2026-09-14.
// Rates live in JSON; missing usage, unknown models and unpriced searches stay null.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PRICING_FILE = fileURLToPath(new URL('../config/gemini-pricing.default.json', import.meta.url));
export function geminiHome() {
  return process.env.ORGIAST_HOME || process.env.USERPROFILE
    || process.cwd().match(/^(\/mnt\/[a-z]\/Users\/[^/]+)/i)?.[1] || os.homedir();
}
const nonnegative = (n) => typeof n === 'number' && Number.isFinite(n) && n >= 0;
const tokens = (n) => Number.isSafeInteger(n) && n >= 0 ? n : null;

// Native usageMetadata is preferred. The OpenAI-compatible Gemini endpoint returns
// usage.prompt_tokens/completion_tokens (completion_tokens already includes thinking).
export function geminiUsage(response = {}) {
  const native = response?.usageMetadata;
  const usage = response?.usage || {};
  const input = tokens(native ? native.promptTokenCount : usage.prompt_tokens);
  const output = tokens(native ? native.candidatesTokenCount : usage.completion_tokens);
  const thoughts = native ? tokens(native.thoughtsTokenCount ?? 0) : 0;
  return {
    inTokens: input,
    outTokens: output === null || thoughts === null ? null : output + thoughts,
    cachedTokens: tokens(native ? native.cachedContentTokenCount ?? 0 : usage.prompt_tokens_details?.cached_tokens ?? 0),
  };
}

export function loadGeminiPricing({ home = geminiHome(), fsImpl = fs } = {}) {
  try { return JSON.parse(fsImpl.readFileSync(path.join(home, '.claude', 'gemini-pricing.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') return {}; // Invalid override must never silently use a different price.
    try { return JSON.parse(fsImpl.readFileSync(DEFAULT_PRICING_FILE, 'utf8')); } catch { return {}; }
  }
}

export function recordGeminiUsage({ model, inTokens, outTokens, source, searchCalls = 0, cachedTokens = 0, mode = 'standard', ...extra }, options = {}) {
  const { home = geminiHome(), fsImpl = fs, now = new Date(), usageFile = path.join(home, '.claude', 'executor-usage.jsonl'), appendImpl } = options;
  const configured = options.pricing ?? loadGeminiPricing({ home, fsImpl });
  const table = configured && typeof configured === 'object' && !Array.isArray(configured) ? configured : {};
  const input = tokens(inTokens), output = tokens(outTokens), cached = tokens(cachedTokens), searches = tokens(searchCalls);
  const rate = table?.models?.[model];
  const valid = (!table.validThrough || new Date(now).toISOString().slice(0, 10) <= table.validThrough)
    && nonnegative(rate?.inputUsdPerMillion) && nonnegative(rate?.outputUsdPerMillion);
  const measured = input !== null && output !== null && cached !== null && cached <= input && searches !== null;
  const multiplier = mode === 'standard' ? 1 : mode === 'batch' ? rate?.batchMultiplier : null;
  const priced = valid && nonnegative(multiplier) && (!cached || nonnegative(rate.cachedInputUsdPerMillion))
    && (searches === 0 || nonnegative(rate.searchUsdPerCall));
  const usd = measured && priced
    ? ((input - cached) * rate.inputUsdPerMillion + cached * (rate.cachedInputUsdPerMillion ?? 0) + output * rate.outputUsdPerMillion) / 1e6 * multiplier + searches * (rate.searchUsdPerCall ?? 0)
    : null;
  const row = { ...extra, t: new Date(now).toISOString(), provider: 'gemini', model: model || 'unknown', in: input, out: output, usd, source, searches };
  if (!measured) row.estimated = true;
  if (!priced) row.pricing = 'unknown';
  if (mode !== 'standard') row.mode = mode;
  if (cached) row.cached = cached;
  if (appendImpl) appendImpl(row, { homeDir: home, usageFile });
  else {
    fsImpl.mkdirSync(path.dirname(usageFile), { recursive: true });
    fsImpl.appendFileSync(usageFile, `${JSON.stringify(row)}\n`);
  }
  return row;
}
