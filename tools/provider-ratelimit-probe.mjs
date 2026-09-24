#!/usr/bin/env node
// provider の「実レート上限」を応答ヘッダから1コールで実測する。
// 背景(2026-09-17 診断): llm-fallback.mjs は retry-after しか読んでおらず、残量を知らずに投げるため
// 429 に必ず当たる。事前に絞る仕組み(流量制御)の前提として、上限と残量を実測できるようにする。
// ここで取れる `x-ratelimit-remaining-tokens` が、流量制御が使う入力そのもの。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnvValue } from './env-kv.mjs';
import { isEntry } from './is-entry.mjs';

// endpoint は llm-ask.mjs と同じものを使う。keyEnv/keyFile も同書式。
export const PROBE_PROVIDERS = Object.freeze({
  groq: { base: 'https://api.groq.com/openai/v1/chat/completions', keyEnv: 'GROQ_API_KEY', keyFile: 'groq.env', model: 'openai/gpt-oss-120b' },
  openrouter: { base: 'https://openrouter.ai/api/v1/chat/completions', keyEnv: 'OPENROUTER_API_KEY', keyFile: 'openrouter.env', model: 'openai/gpt-oss-120b' },
  cerebras: { base: 'https://api.cerebras.ai/v1/chat/completions', keyEnv: 'CEREBRAS_API_KEY', keyFile: 'cerebras.env', model: 'zai-glm-4.7' },
  deepseek: { base: 'https://api.deepseek.com/chat/completions', keyEnv: 'DEEPSEEK_API_KEY', keyFile: 'deepseek.env', model: 'deepseek-chat' },
  grok: { base: 'https://api.x.ai/v1/chat/completions', keyEnv: 'XAI_API_KEY', keyFile: 'xai.env', model: 'grok-3' },
  kimi: { base: 'https://api.moonshot.ai/v1/chat/completions', keyEnv: 'MOONSHOT_API_KEY', keyFile: 'kimi-api.env', model: 'kimi-k3' },
});

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

// ヘッダは Headers でも素の object でも受ける(テスト・プロキシ経由の両対応)。
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

export function loadProbeKey(provider, { home = process.env.ORGIAST_HOME || os.homedir(), env = process.env } = {}) {
  const config = PROBE_PROVIDERS[provider];
  if (!config) return '';
  return env[config.keyEnv] || readEnvValue(path.join(home, '.claude', config.keyFile), config.keyEnv);
}

// 1コールだけ投げ、上限ヘッダを読む。max_tokens:1 なので課金はほぼゼロ。
export async function probeRateLimits({ provider, model, key, fetchImpl = fetch, now = () => Date.now() } = {}) {
  const config = PROBE_PROVIDERS[provider];
  if (!config) throw new Error(`未知の provider: ${provider} (対応: ${Object.keys(PROBE_PROVIDERS).join(', ')})`);
  const useModel = model || config.model;
  const at = new Date(now()).toISOString();
  if (!key) return { provider, model: useModel, at, ok: false, reason: `${config.keyEnv} 未取得` };
  try {
    const response = await fetchImpl(config.base, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: useModel, messages: [{ role: 'user', content: 'ping' }], max_tokens: 1 }),
    });
    const limits = parseRateLimitHeaders(response.headers);
    const usage = response.ok ? (await response.json().catch(() => null))?.usage ?? null : null;
    const entry = { provider, model: useModel, at, ok: response.ok, status: response.status, limits, usage };
    if (!response.ok) {
      entry.reason = `HTTP ${response.status}`;
      entry.retryAfter = headerValue(response.headers, 'retry-after') ?? null;
    }
    // 成功したのにヘッダが1本も無い = そのプロバイダは残量を開示していない(流量制御は台帳推定に落とす)
    if (response.ok && !limits) entry.reason = '応答ヘッダに x-ratelimit-* が無い(上限を開示しない provider)';
    return entry;
  } catch (error) {
    return { provider, model: useModel, at, ok: false, reason: `network: ${error?.message || error}` };
  }
}

export function formatProbeLine(entry) {
  if (!entry.ok) return `⚠️ ${entry.provider}/${entry.model}: ${entry.reason}`;
  const l = entry.limits || {};
  const rate = l.limitTokens == null ? '上限非開示' : `TPM ${l.limitTokens} / 残 ${l.remainingTokens} / RPD ${l.limitRequests} / 残 ${l.remainingRequests}`;
  return `📊 ${entry.provider}/${entry.model}: ${rate}${entry.limits?.resetTokens ? ` (tokens reset ${entry.limits.resetTokens})` : ''}`;
}

// provider+model 単位で最新値だけを残す(履歴は上書き)。
export function mergeMeasurement(file, entry) {
  let store = {};
  try { store = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  const key = `${entry.provider}/${entry.model}`;
  store[key] = entry;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(store, null, 2)}\n`);
  return store;
}

export function measurementFile(home = process.env.ORGIAST_HOME || os.homedir()) {
  return path.join(home, '.claude', 'provider-ratelimits.json');
}

export async function main(argv = process.argv.slice(2), { home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  const flag = (name, fallback) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback; };
  const provider = flag('--provider', 'groq');
  const model = flag('--model', '');
  const entry = await probeRateLimits({ provider, model, key: loadProbeKey(provider, { home }) });
  if (argv.includes('--json')) console.log(JSON.stringify(entry, null, 2));
  else console.log(formatProbeLine(entry));
  mergeMeasurement(measurementFile(home), entry);
  return entry.ok ? 0 : 1;
}

// process.exit() は Windows で keep-alive ソケットのクローズと競合し
// `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` で落ちる(2026-09-25 実測)。
// 終了コードだけ立てて自然終了させる。
if (isEntry(import.meta.url)) process.exitCode = await main();
