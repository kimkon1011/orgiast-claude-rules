import { redactSecrets } from '../redact-secrets.mjs';

// Shared by memory export and case transcripts. Redact before truncating tools:
// cutting a PEM block or a credential in half first defeats pattern matching.
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

// Memory export historically excludes unredactable files entirely. Keep that
// contract while transcripts must preserve speech with credential placeholders.
export const redactMemoryForShare = text => redactSecrets(text).replace(/[A-Fa-f0-9]{40,}/g, '***REDACTED***');

export function redactForShare(text) {
  let value = String(text)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '***REDACTED***')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, 'Bearer ***REDACTED***')
    .replace(/(["']?(?:[\w-]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)|authorization|cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1"***REDACTED***"');
  value = redactSecrets(value).replace(/[A-Fa-f0-9]{40,}/g, '***REDACTED***');
  return value;
}
