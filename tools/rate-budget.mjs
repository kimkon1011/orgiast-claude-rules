// provider の分窓トークン残量を永続バケットとして持ち、429 を「受けてから避ける」のではなく
// 「受ける前に絞る」ための判定を提供する。
//
// 背景(2026-09-17 診断 / 2026-09-25 実測): groq は x-ratelimit-remaining-tokens を返すのに
// llm-fallback.mjs は retry-after しか読んでおらず、残量を知らずに投げるため必ず上限に当たる。
// 実測値は groq/openai/gpt-oss-120b で TPM 8,000・RPD 1,000。夜間バッチには狭すぎる。
//
// 残量は時間とともに limitTokens へ向かって増えるだけなので、直近応答の残量は
// 「次の1分間に使える量の下限」として安全側に使える。
import fs from 'node:fs';

// ここは依存ゼロに保つ。llm-fallback.mjs が読み込む側なので、eval-harness のように
// tools を最小コピーして走らせるテストへ持ち込むファイルを増やさないため。
const HEADER_KEYS = Object.freeze({
  limitRequests: 'x-ratelimit-limit-requests',
  limitTokens: 'x-ratelimit-limit-tokens',
  remainingRequests: 'x-ratelimit-remaining-requests',
  remainingTokens: 'x-ratelimit-remaining-tokens',
  resetRequests: 'x-ratelimit-reset-requests',
  resetTokens: 'x-ratelimit-reset-tokens',
});

function numeric(value) {
  if (value == null || value === '') return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

function headerValue(headers, name) {
  if (!headers) return null;
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name];
  return value == null ? null : String(value);
}

// 上限系は数値化する。reset は "547ms" のような文字列なので生のまま残す(単位が実装依存のため)。
export function parseRateLimitHeaders(headers) {
  const raw = {};
  const out = { raw };
  for (const [field, name] of Object.entries(HEADER_KEYS)) {
    const value = headerValue(headers, name);
    if (value == null) continue;
    raw[name] = value;
    out[field] = field.startsWith('reset') ? value : numeric(value);
  }
  return Object.keys(raw).length ? out : null;
}

// "547ms" / "3h12m57.6s" / "1m30s" 形式。groq は複合表記で返す。
export function parseDuration(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  const unitMs = { d: 86400000, h: 3600000, m: 60000, s: 1000, ms: 1 };
  const matches = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|d|h|m|s)/g)];
  if (!matches.length) return null;
  const consumed = matches.map((m) => m[0]).join('');
  if (consumed !== text) return null; // 想定外の書式は推測せず null(誤った窓で締め切らない)
  return matches.reduce((total, [, n, unit]) => total + Number(n) * unitMs[unit], 0);
}

export function readBudget(file) {
  try {
    const store = JSON.parse(fs.readFileSync(file, 'utf8'));
    return store && typeof store === 'object' ? store : {};
  } catch { return {}; }
}

export function writeBudget(file, store) {
  try {
    fs.mkdirSync(file.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
  } catch {}
}

// プロンプトのトークン数は厳密には数えられないので、本文長/4 の粗い見積もりに係数を掛けて安全側に倒す。
export function estimateTokens(request, { charsPerToken = 4, safety = 1.2 } = {}) {
  const body = request?.init?.body;
  if (body == null) return 0;
  const size = typeof body === 'string' ? body.length : Buffer.byteLength(String(body));
  return Math.ceil((size / charsPerToken) * safety);
}

// 窓が明けていれば残量を limit まで回復させてから見る(古い残量で不当に締め切らない)。
export function refreshEntry(entry, now) {
  if (!entry) return null;
  const resetAt = Number(entry.tokensResetAt);
  if (Number.isFinite(resetAt) && resetAt > 0 && now >= resetAt) {
    return { ...entry, remainingTokens: Number.isFinite(Number(entry.limitTokens)) ? Number(entry.limitTokens) : null, tokensResetAt: null };
  }
  return entry;
}

export function budgetVerdict({ store, provider, neededTokens, now = Date.now() }) {
  const entry = refreshEntry(store?.[provider], now);
  const remaining = Number(entry?.remainingTokens);
  // 未計測の provider は素通し(計測できるまで絞りようがない)。既存挙動を変えない。
  if (!Number.isFinite(remaining)) return { allow: true, remaining: null };
  if (neededTokens > remaining) return { allow: false, remaining, neededTokens, reason: `budget: 残${remaining} < 必要見積${neededTokens}` };
  return { allow: true, remaining, neededTokens };
}

// 応答ヘッダで下限を更新する。ヘッダを返さない provider は何もしない(既存挙動を変えない)。
export function noteResponse(store, provider, headers, now = Date.now()) {
  const parsed = parseRateLimitHeaders(headers);
  if (!parsed || parsed.remainingTokens == null) return false;
  const resetMs = parseDuration(parsed.resetTokens);
  store[provider] = {
    limitTokens: parsed.limitTokens ?? null,
    remainingTokens: parsed.remainingTokens,
    tokensResetAt: resetMs == null ? null : now + resetMs,
    updatedAt: now,
  };
  return true;
}
