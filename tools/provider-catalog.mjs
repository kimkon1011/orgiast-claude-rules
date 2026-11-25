// 能力ゲートと URL ゲートで同じプロバイダ識別を使う。
import fs from 'node:fs';
export const catalog = JSON.parse(fs.readFileSync(new URL('./ai-subscription-catalog.json', import.meta.url), 'utf8')).services;
const hosts = {
 openrouter: ['openrouter.ai'], genspark: ['genspark.ai'], codex: ['platform.openai.com', 'chatgpt.com'],
 grok: ['console.x.ai'], xai: ['console.x.ai'], deepseek: ['platform.deepseek.com'], kimi: ['platform.moonshot.cn'],
 groq: ['console.groq.com'], mistral: ['console.mistral.ai'], gemini: ['aistudio.google.com'],
};
export const providerHosts = service => [...(hosts[service.id] || []), ...(service.hosts || [])];
export const providerAliases = service => [...new Set([service.id, service.name, service.vendor,
 ...(service.keyFiles || []).flatMap(file => [file, file.split('/').pop().replace(/\.env$/, '')]), ...providerHosts(service)])].filter(Boolean);
export function providerForHost(host, services = catalog) {
 return services.find(service => providerHosts(service).some(domain => host === domain || host.endsWith('.' + domain)));
}
