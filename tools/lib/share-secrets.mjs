import { redactForShare as redactShared } from './share-content.mjs';

// Extend the shared memory/knowledge filter for full conversational text.
// Redact before truncating tool output, especially multiline private keys.
export function redactForShare(text) {
  let value = String(text)
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '***REDACTED***')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, 'Bearer ***REDACTED***')
    .replace(/(["']?(?:[\w-]*(?:secret|token|password|passwd|api[_-]?key|private[_-]?key)|authorization|cookie)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1"***REDACTED***"');
  value = redactShared(value);
  return value;
}
