/**
 * Shared LLM creation for autoreply modules.
 * Extracted from discord-autoreply.mjs to break the circular import
 * discord-autoreply.mjs -> lib/autoreply-related.mjs -> discord-autoreply.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { callWithFallback, FALLBACK_CHAIN, preferredForCategory } from '../llm-fallback.mjs';
import { PROVIDERS, parseEnvText } from '../line-digest.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; } };

// line-digest exports the common providers; supplement the CLI-only entries from llm-ask.
const LLM_PROVIDERS = {
  ...PROVIDERS,
  glm: { url: 'https://api.z.ai/api/coding/paas/v4/chat/completions', env: 'ZAI_API_KEY', file: 'zai.env', model: 'glm-5.3' },
  genspark: { url: 'https://www.genspark.ai/api/llm_proxy/v1/chat/completions', env: 'GSK_PROXY_KEY', file: 'genspark-proxy.env', model: 'gpt-5.6-luna' },
  mistral: { url: 'https://api.mistral.ai/v1/chat/completions', env: 'MISTRAL_API_KEY', file: 'mistral.env', model: 'open-mistral-nemo' },
};
// 返信文は日本語品質が要る。直 API の Gemini/DeepSeek は残高切れ(402)で kimi-k3（$16/M out）へ落ちていた
// (2026-11 実測: 有料支出の 53%)。日本語実測は gpt-oss-120b 100%、deepseek 92-94%、gemini 90%、kimi 87%。
// 先頭は約 1/13 の gpt-oss、次に OpenRouter の deepseek-v4-flash（routeCandidate が openrouter へ寄せる）。
// Gemini は 402 で callWithFallback が次へ進む。DISCORD_AUTOREPLY_PROVIDER で先頭を差し替え可。
export const REPLY_CHAIN = Object.freeze([
  { provider: 'groq', model: 'openai/gpt-oss-120b' },
  { provider: 'openrouter', model: 'openai/gpt-oss-120b' },
  { provider: 'deepseek', model: 'deepseek-v4-flash' },
  { provider: 'gemini', model: 'gemini-3.6-flash' },
  { provider: 'kimi', model: 'kimi-k3' },
  { provider: 'genspark', model: 'gpt-5.6-luna' },
]);
// 画像・添付がある場合の連鎖。Gemini 直 → OpenRouter の画像対応 Gemini → Kimi。
export const IMAGE_REPLY_CHAIN = Object.freeze([
  { provider: 'gemini', model: 'gemini-3.6-flash' },
  { provider: 'openrouter', model: 'google/gemini-3.7-flash' },
  { provider: 'kimi', model: 'kimi-k3' },
]);

export function createLlm({ home, fetchImpl, sleepImpl = sleep, env = process.env }) {
  return async ({ category, system, input }) => {
    const isReply = category === 'jp_reply';
    const hasImages = Array.isArray(input?.images) && input.images.length > 0;
    const forced = env.DISCORD_AUTOREPLY_PROVIDER && LLM_PROVIDERS[env.DISCORD_AUTOREPLY_PROVIDER]
      ? { provider: env.DISCORD_AUTOREPLY_PROVIDER, model: LLM_PROVIDERS[env.DISCORD_AUTOREPLY_PROVIDER].model } : null;
    const replyChain = hasImages ? IMAGE_REPLY_CHAIN : REPLY_CHAIN;
    const routed = hasImages ? IMAGE_REPLY_CHAIN[0] : isReply ? (forced || replyChain[0]) : preferredForCategory(category);
    const chain = hasImages ? IMAGE_REPLY_CHAIN : isReply ? replyChain : FALLBACK_CHAIN;
    const start = routed && LLM_PROVIDERS[routed.provider] ? routed : chain[0];
    const result = await callWithFallback({
      start, chain, fetchImpl, sleepImpl,
      caller: 'discord-autoreply',
      cooldownFile: path.join(home, '.claude', 'provider-cooldown.json'),
      ledgerFile: path.join(home, '.claude', 'executor-usage.jsonl'),
      budgetFile: path.join(home, '.claude', 'provider-budget.json'),
      payloadFor(candidate) {
        const p = LLM_PROVIDERS[candidate.provider];
        // The shared router canonicalizes the Kimi alias to OpenRouter.
        const imageCapable = IMAGE_REPLY_CHAIN.some(x => x.provider === candidate.provider)
          || (candidate.provider === 'openrouter' && /^moonshotai\/kimi-/.test(candidate.model || ''));
        if (hasImages && !imageCapable) return null;
        if (!p || /claude|anthropic|fable/i.test(candidate.model || '')) return null;
        const files = [path.join(home, '.claude', p.file)];
        if (candidate.provider === 'gemini') files.unshift(path.join(home, '.gemini', '.env'));
        const key = process.env[p.env] || files.map(f => parseEnvText(read(f))[p.env]).find(Boolean);
        if (!key) return null;
        const body = { model: candidate.model || p.model, stream: false, max_tokens: 6000,
          messages: [{ role: 'system', content: system }, { role: 'user', content: hasImages
            ? [{ type: 'text', text: JSON.stringify({ ...input, images: undefined }) },
              ...input.images.slice(0, 4).map(img => ({ type: 'image_url', image_url: { url: img.dataUrl } }))]
            : JSON.stringify(input) }] };
        if (candidate.provider === 'deepseek' && /deepseek-flash|deepseek-v4-flash/.test(body.model || '')) body.thinking = { type: 'disabled' };
        if (String(candidate.model || '').includes('deepseek-v4-flash')) body.reasoning = { enabled: false };
        if (p.special === 'kimi') Object.assign(body, { reasoning_effort: 'none', temperature: 0.6 });
        return { url: p.url, init: { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...p.extraHeaders }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) } };
      },
    });
    return (await result.response.json()).choices?.[0]?.message?.content || '';
  };
}