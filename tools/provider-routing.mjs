// Kimi / DeepSeek inference always uses the auto-recharged OpenRouter wallet.
export const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';
export const OPENROUTER_ANTHROPIC_BASE = 'https://openrouter.ai/api';
export const GATEWAY_MODELS = Object.freeze({ kimi: 'moonshotai/kimi-k3', deepseek: 'deepseek/deepseek-v4-flash' });
export function gatewayModel(provider, model) {
  if (!GATEWAY_MODELS[provider]) return model;
  if (!model) return GATEWAY_MODELS[provider];
  if (model.includes('/')) return model;
  const aliases = { 'deepseek-flash': 'deepseek-v4-flash', 'deepseek-chat': 'deepseek-v4-flash', 'deepseek-reasoner': 'deepseek-v4-flash', 'deepseek-pro': 'deepseek-v4-pro', 'kimi-latest': 'kimi-k3', 'kimi-k2-turbo-preview': 'kimi-k2-0905', 'kimi-k2-0711-preview': 'kimi-k2', 'kimi-k2-0905-preview': 'kimi-k2-0905' };
  return `${provider === 'kimi' ? 'moonshotai' : 'deepseek'}/${aliases[model] || model}`;
}
export function routeCandidate(candidate) {
  return candidate && GATEWAY_MODELS[candidate.provider]
    ? { ...candidate, provider: 'openrouter', model: gatewayModel(candidate.provider, candidate.model) } : candidate;
}
export function gatewayConfig(provider) {
  return { base: `${OPENROUTER_BASE}/chat/completions`, keyEnv: 'OPENROUTER_API_KEY', keyFile: 'openrouter.env', model: GATEWAY_MODELS[provider] };
}
export function gatewayParams(model) {
  return model === GATEWAY_MODELS.deepseek || model === GATEWAY_MODELS.kimi ? { reasoning: { enabled: false } } : {};
}
// OpenRouter reports actual billed USD, including provider pricing and cache discounts.
export function usageCostFields(usage) {
  return typeof usage?.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? { usd: usage.cost } : {};
}
