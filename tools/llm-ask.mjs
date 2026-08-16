// llm-ask.mjs — 複数プロバイダのLLMを1本で叩く統合CLIヘルパー(OpenAI互換API)。
// 目的: 従量Claudeを安い/無料/高速枠へ逃がす(§1.13/§1.17.1)。タスクごとに最安・最速で足りるモデルへ。
// 使い方: node llm-ask.mjs --provider <name> "指示"  [--model X] [--system S] [--max N]
//   provider: openrouter | groq | gemini | kimi | mistral
//   例: node llm-ask.mjs --provider groq "この問い合わせを分類して"
//       node llm-ask.mjs --provider openrouter --model deepseek/deepseek-chat "下書きして"
// 認証: 各プロバイダのキーを env もしくは ~/.claude/<file> から読む(下表)。
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const PROVIDERS = {
  // 1キーで413モデル+無料19本。既定は安く賢いLlama3.3-70b。--modelで任意(例 deepseek/deepseek-chat, qwen/qwen-2.5-72b-instruct, *:free)
  openrouter: { base: 'https://openrouter.ai/api/v1/chat/completions', keyEnv: 'OPENROUTER_API_KEY', keyFile: 'openrouter.env', model: 'meta-llama/llama-3.3-70b-instruct', extraHeaders: { 'HTTP-Referer': 'https://orgiast.jp', 'X-Title': 'orgiast' } },
  // 超高速(LPU)・安。分類/抽出/量産向け。
  groq: { base: 'https://api.groq.com/openai/v1/chat/completions', keyEnv: 'GROQ_API_KEY', keyFile: 'groq.env', model: 'llama-3.3-70b-versatile' },
  // Gemini Flash(激安・1M文脈・高速)。キーは ~/.gemini/.env の GEMINI_API_KEY を流用。
  gemini: { base: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', keyEnv: 'GEMINI_API_KEY', keyFile: 'gemini.env', model: 'gemini-3.7-flash' },
  // Kimi K3(別課金プール=Moonshot前払い)。reasoning_effort=none+temp0.6でSonnet並(既定onは遅く高い)。
  kimi: { base: 'https://api.moonshot.ai/v1/chat/completions', keyEnv: 'MOONSHOT_API_KEY', keyFile: 'kimi-api.env', model: 'kimi-k3', special: 'kimi' },
  // Mistral / Codestral(安いコード補助)。
  mistral: { base: 'https://api.mistral.ai/v1/chat/completions', keyEnv: 'MISTRAL_API_KEY', keyFile: 'mistral.env', model: 'mistral-large-latest' },
};

const args = process.argv.slice(2);
function opt(name, def) { const i = args.indexOf(name); return (i >= 0 && args[i + 1]) ? args[i + 1] : def; }
const provider = (opt('--provider', '') || '').toLowerCase();
const P = PROVIDERS[provider];
if (!P) { console.error('使い方: node llm-ask.mjs --provider <openrouter|groq|gemini|kimi|mistral> "指示" [--model X] [--system S] [--max N]'); process.exit(2); }
const model = opt('--model', P.model);
const system = opt('--system', '');
const maxTok = parseInt(opt('--max', '4000'), 10) || 4000;
// フラグ位置を除いた残りを本文に(--flag value を確実に除去)
const skip = new Set();
['--provider', '--model', '--system', '--max'].forEach((f) => { const i = args.indexOf(f); if (i >= 0) { skip.add(i); skip.add(i + 1); } });
const prompt = args.filter((a, i) => !a.startsWith('--') && !skip.has(i)).join(' ').trim();

function loadKey() {
  if (process.env[P.keyEnv]) return process.env[P.keyEnv];
  const files = [path.join(os.homedir(), '.claude', P.keyFile)];
  if (provider === 'gemini') files.unshift(path.join(os.homedir(), '.gemini', '.env')); // Geminiキーは ~/.gemini/.env にある
  for (const f of files) {
    try { for (const l of fs.readFileSync(f, 'utf-8').split(/\r?\n/)) { if (l.startsWith(P.keyEnv + '=')) return l.slice(P.keyEnv.length + 1).trim(); } } catch {}
  }
  return '';
}
const KEY = loadKey();
if (!KEY) { console.error(`${P.keyEnv} 未設定 (env もしくは ~/.claude/${P.keyFile}${provider === 'gemini' ? ' か ~/.gemini/.env' : ''})`); process.exit(2); }
if (!prompt) { console.error('指示テキストがありません'); process.exit(2); }

const messages = [];
if (system) messages.push({ role: 'system', content: system });
messages.push({ role: 'user', content: prompt });
const payload = { model, messages, max_tokens: maxTok, stream: false };
if (P.special === 'kimi') { payload.reasoning_effort = 'none'; payload.temperature = 0.6; } // K3実運用モード(速く正常出力)

(async () => {
  const start = Date.now();
  try {
    const r = await fetch(P.base, { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(P.extraHeaders || {}) }, body: JSON.stringify(payload) });
    if (!r.ok) { console.error(`${provider} 失敗 ${r.status}: ${(await r.text().catch(() => '')).slice(0, 400)}`); process.exitCode = 1; return; }
    const j = await r.json();
    const text = j.choices?.[0]?.message?.content ?? '';
    const u = j.usage ?? {};
    const secs = ((Date.now() - start) / 1000).toFixed(1);
    console.log((text.trim()) || '(出力なし)');
    console.error(`[${provider}:${model}] ${secs}秒 in=${u.prompt_tokens || 0} out=${u.completion_tokens || 0}tok`);
  } catch (e) { console.error(`${provider} 例外: ${e.message}`); process.exitCode = 1; }
})();
