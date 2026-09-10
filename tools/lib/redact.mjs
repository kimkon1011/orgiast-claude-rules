const WEBHOOK_RE = /https:\/\/discord\.com\/api\/webhooks\/(\d{15,})\/([A-Za-z0-9_-]{40,})/g;

export function redactAll(value) {
  return String(value ?? '')
    .replace(WEBHOOK_RE, 'https://discord.com/api/webhooks/$1/[REDACTED]')
    .replace(/-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|(?:ghp_|gho_)[A-Za-z0-9_]{16,}|github_pat_[A-Za-z0-9_]{16,}|xox[abp]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,})\b/g, '[REDACTED]')
    .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(key|token|secret|password)(\s*=\s*)([^\s&;,]+)/gi, '$1$2[REDACTED]')
    .replace(/\b(?:[A-Fa-f0-9]{40,}|[A-Za-z0-9+/]{40,}={0,2})\b/g, '[REDACTED]');
}
