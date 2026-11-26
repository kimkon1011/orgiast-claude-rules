import fs from 'node:fs';
import path from 'node:path';

export const KEYSERVE_TIERS = Object.freeze(['minimal', 'ai', 'project', 'workspace']);
const MINIMAL_LANES = new Set(['codex', 'deepseek', 'qwen', 'cheap-code:deepseek', 'openrouter', 'openrouter-free', 'openrouter-code']);

export function normalizeKeyserveTier(value, fallback = 'ai') {
  return KEYSERVE_TIERS.includes(value) ? value : fallback;
}

export function keyserveTierState(home) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', '.keys-sync-state.json'), 'utf8').replace(/^\uFEFF/, ''));
    return normalizeKeyserveTier(state.tier);
  } catch { return 'ai'; }
}

export function tierIncludes(activeTier, requiredTier = 'ai') {
  return KEYSERVE_TIERS.indexOf(normalizeKeyserveTier(activeTier)) >= KEYSERVE_TIERS.indexOf(normalizeKeyserveTier(requiredTier));
}

// Diagnostic/routing policy only. The server is the authorization boundary.
export function keyserveLaneAllowed(home, lane) {
  return keyserveTierState(home) !== 'minimal' || MINIMAL_LANES.has(lane);
}
