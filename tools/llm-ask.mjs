// 複数プロバイダのLLMを1本で叩く統合CLIヘルパー。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { readEnvValue } from './env-kv.mjs';
import { callWithFallback, FALLBACK_CHAIN } from './llm-fallback.mjs';

const PROVIDERS = {
  // 実測で精度が高く、llama-3.3-70b より安価な共通既定モデル。
  openrouter: { base: 'https://openrouter.ai/api/v1/chat/completions', keyEnv: 'OPENROUTER_API_KEY', keyFile: 'openrouter.env', model: 'openai/gpt-oss-120b', extraHeaders: { 'HTTP-Referer': 'https://orgiast.jp', 'X-Title': 'orgiast' } },
  groq: { base: 'https://api.groq.com/openai/v1/chat/completions', keyEnv: 'GROQ_API_KEY', keyFile: 'groq.env', model: 'openai/gpt-oss-120b' },
  // 汎用エンドポイントはウォレット従量課金になるため、Coding Plan のサブスク枠専用エンドポイントを使う。
  glm: { base: 'https://api.z.ai/api/coding/paas/v4/chat/completions', keyEnv: 'ZAI_API_KEY', keyFile: 'zai.env', model: 'glm-5.3' },
  // Cerebras Code(定額サブスク・GLM-4.7・24M tok/日)。従量プロバイダより先に使いたいので連鎖では groq の直後。
  cerebras: { base: 'https://api.cerebras.ai/v1/chat/completions', keyEnv: 'CEREBRAS_API_KEY', keyFile: 'cerebras.env', model: 'zai-glm-4.7' },
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', keyEnv: 'GEMINI_API_KEY', keyFile: 'gemini.env', model: 'gemini-3.7-flash' },
  deepseek: { base: 'https://api.deepseek.com/chat/completions', keyEnv: 'DEEPSEEK_API_KEY', keyFile: 'deepseek.env', model: 'deepseek-chat' },
  grok: { base: 'https://api.x.ai/v1/chat/completions', keyEnv: 'XAI_API_KEY', keyFile: 'xai.env', model: 'grok-3' },
  kimi: { base: 'https://api.moonshot.ai/v1/chat/completions', keyEnv: 'MOONSHOT_API_KEY', keyFile: 'kimi-api.env', model: 'kimi-k3', special: 'kimi' },
  mistral: { base: 'https://api.mistral.ai/v1/chat/completions', keyEnv: 'MISTRAL_API_KEY', keyFile: 'mistral.env', model: 'mistral-large-latest' },
};

const args = process.argv.slice(2);
function opt(name, def) { const i = args.indexOf(name); return (i >= 0 && args[i + 1]) ? args[i + 1] : def; }
const provider = (opt('--provider', '') || '').toLowerCase();
const selected = PROVIDERS[provider];
if (!selected) { console.error('使い方: node llm-ask.mjs --provider <openrouter|groq|glm|cerebras|gemini|deepseek|grok|kimi|mistral> "指示" [--model X] [--system S] [--max N] [--no-fallback]'); process.exit(2); }
const model = opt('--model', selected.model);
const system = opt('--system', '');
const maxTok = parseInt(opt('--max', '4000'), 10) || 4000;
const skip = new Set();
['--provider', '--model', '--system', '--max'].forEach((flag) => { const i = args.indexOf(flag); if (i >= 0) { skip.add(i); skip.add(i + 1); } });
const prompt = args.filter((arg, i) => !arg.startsWith('--') && !skip.has(i)).join(' ').trim();
const home = process.env.ORGIAST_HOME || os.homedir();

function loadKey(name) {
  const P = PROVIDERS[name];
  if (!P) return '';
  if (process.env[P.keyEnv]) return process.env[P.keyEnv];
  const files = [path.join(home, '.claude', P.keyFile)];
  if (name === 'gemini') files.unshift(path.join(home, '.gemini', '.env'));
  for (const file of files) { const value = readEnvValue(file, P.keyEnv); if (value) return value; }
  return '';
}
const selectedKey = loadKey(provider);
if (args.includes('--print-key-status')) { console.log(selectedKey ? `${selected.keyEnv}: 設定済み` : `${selected.keyEnv}: 未設定`); process.exit(selectedKey ? 0 : 2); }
if (!prompt) { console.error('指示テキストがありません'); process.exit(2); }

const messages = [];
if (system) messages.push({ role: 'system', content: system });
messages.push({ role: 'user', content: prompt });
const ledger = path.join(home, '.claude', 'executor-usage.jsonl');
function appendAttempt(info, usage = {}) {
  const rec = { t: new Date().toISOString(), provider: info.candidate.provider, model: info.candidate.model, in: usage.prompt_tokens || 0, out: usage.completion_tokens || 0, secs: Number(info.secs.toFixed(3)), status: info.status, attempt: info.attempt, failover: info.failover };
  try { fs.mkdirSync(path.dirname(ledger), { recursive: true }); fs.appendFileSync(ledger, JSON.stringify(rec) + '\n'); } catch {}
}

try {
  const result = await callWithFallback({
    start: { provider, model },
    chain: args.includes('--no-fallback') ? [] : FALLBACK_CHAIN,
    payloadFor(candidate) {
      const P = PROVIDERS[candidate.provider]; const key = loadKey(candidate.provider);
      if (!P || !key) return null;
      const payload = { model: candidate.model || P.model, messages, max_tokens: maxTok, stream: false };
      if (P.special === 'kimi') Object.assign(payload, { reasoning_effort: 'none', temperature: 0.6 });
      return { url: P.base, init: { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(P.extraHeaders || {}) }, body: JSON.stringify(payload) } };
    },
    async onAttempt(info) {
      let usage = {};
      if (info.status === 'ok') usage = (await info.response.clone().json().catch(() => ({}))).usage || {};
      appendAttempt(info, usage);
    },
    onFailover({ from, to, reason }) { console.error(`[failover] ${from.provider}:${from.model} ${reason} → ${to.provider}:${to.model}`); },
  });
  const json = await result.response.json();
  const text = json.choices?.[0]?.message?.content ?? '';
  const usage = json.usage ?? {};
  console.log(text.trim() || '(出力なし)');
  console.error(`[${result.candidate.provider}:${result.candidate.model}] in=${usage.prompt_tokens || 0} out=${usage.completion_tokens || 0}tok`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
