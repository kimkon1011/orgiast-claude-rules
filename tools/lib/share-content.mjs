// Shared credential filtering for memory and knowledge exports.
import { redactSecrets } from '../redact-secrets.mjs';

// 伏字化した後の本文に対して判定する。伏字で消せない秘密が残るファイルだけを丸ごと除外する。
export const SECRET_PATTERNS = [
  ['Discord webhook URL', /discord\.com\/api\/webhooks\/\d/i],
  ['OpenAI API key', /sk-[A-Za-z0-9]{20,}/],
  ['Groq API key', /gsk_[A-Za-z0-9]{20,}/],
  ['GitHub token', /ghp_[A-Za-z0-9]{20,}/],
  ['Slack bot token', /xoxb-(?!\*\*\*REDACTED\*\*\*)/],
  ['Google API key', /AIza[A-Za-z0-9_-]{20,}/],
  ['private key', /-----BEGIN .*PRIVATE KEY-----/],
  ['40文字以上のhex', /[A-Fa-f0-9]{40,}/],
  ['ORGIAST_SHARED_SECRET', /ORGIAST_SHARED_SECRET\s*=\s*\S/],
];

export function redactForShare(text) {
  // redactSecrets handles token formats/URLs. Also cover named env/JSON fields:
  // a word boundary before "token" alone does not match DISCORD_BOT_TOKEN.
  const named = String(text).replace(
    /(\b(?:[A-Za-z][A-Za-z0-9_]*_)?(?:token|secret|password|passwd|api_key|access_key)\b["']?\s*[:=]\s*)(["']?)([^\s"'`,;}]+)(["']?)/gi,
    (_match, prefix, quote, _value, closing) => `${prefix}${quote}***REDACTED***${closing}`,
  ).replace(/(\bBearer\s+)[A-Za-z0-9._~+/-]{16,}/gi, '$1***REDACTED***');
  return redactSecrets(named).replace(/[A-Fa-f0-9]{40,}/g, '***REDACTED***');
}
export const findSharedSecret = text => SECRET_PATTERNS.find(([, pattern]) => pattern.test(text));

export function parseMemoryFrontmatter(text) {
  const match = /^(?:\uFEFF)?---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/.exec(String(text));
  if (!match) return {};
  let inMetadata = false;
  const result = {};
  for (const line of match[1].split(/\r?\n/)) {
    const metadata = /^metadata\s*:\s*(?:#.*)?$/.exec(line);
    if (metadata) { inMetadata = true; continue; }
    const nested = /^\s+([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (inMetadata && nested) { result[`metadata.${nested[1]}`] = nested[2].replace(/^(['"])(.*)\1$/, '$2'); continue; }
    if (/^\S/.test(line)) inMetadata = false;
    const top = /^([A-Za-z][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (top) result[top[1]] = top[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return result;
}

