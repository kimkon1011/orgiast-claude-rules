// OpenRouter 代替レーン宣言（config/lane-openrouter-substitutes.json）の読取。
// lane-doctor の substituted 判定の正本。ハードコード分岐をここに寄せる。
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const LANE_SUBSTITUTES_PATH = fileURLToPath(new URL('../../config/lane-openrouter-substitutes.json', import.meta.url));

export function loadLaneSubstitutes(file = LANE_SUBSTITUTES_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

function providerMatches(providers, provider) {
  if (!providers || providers.includes('*')) return true;
  return providers.includes(provider);
}

function reasonMatches(rule, state, billingEntry, viaAlive) {
  const reason = state?.reason || '';
  const match = rule.match || {};
  if (match.reasonEquals != null && reason !== match.reasonEquals) return false;
  if (match.reasonIncludes != null && !reason.includes(match.reasonIncludes)) return false;
  if (match.autoTopUp === false && billingEntry?.autoTopUp !== false) return false;
  if (rule.requireViaAlive && !viaAlive) return false;
  return match.reasonEquals != null || match.reasonIncludes != null;
}

// lanes + provider-billing から substituted 一覧を返す。via の付与は呼び出し側。
export function computeSubstituted(lanes, {
  billing = {},
  ledger = loadLaneSubstitutes(),
  isLane = () => true,
} = {}) {
  const via = ledger.via || 'openrouter';
  const viaAlive = Boolean(lanes?.[via]?.alive);
  const out = [];
  for (const [provider, state] of Object.entries(lanes || {})) {
    if (!isLane(provider) || !state) continue;
    for (const rule of ledger.rules || []) {
      if (!providerMatches(rule.providers, provider)) continue;
      if (!reasonMatches(rule, state, billing[provider], viaAlive)) continue;
      out.push({ provider, via: rule.via || via });
      break;
    }
  }
  return out;
}

// 代替先が生存しているなら、停止・要修復として数えない。
export function substituteActive(state, health) {
  return Boolean(state?.via && health?.lanes?.[state.via]?.alive);
}
