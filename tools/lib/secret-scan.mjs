import fs from 'node:fs';
import path from 'node:path';

const SENSITIVE_FILE_PATTERNS = [
  ['environment-file', /(^|\/)\.env(?:\.[^/]*)?$/i],
  ['private-key-file', /\.(?:pem|key)$/i],
  ['credentials-file', /(^|\/)credentials[^/]*\.json$/i],
];

const CONTENT_PATTERNS = [
  ['private-key', /-----BEGIN [^-\r\n]*PRIVATE KEY-----/],
  ['github-token', /\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]{8,}/],
  ['slack-token', /\bxox[bap]-[A-Za-z0-9-]{8,}/],
  ['aws-access-key', /\bAKIA[A-Z0-9]{12,}/],
  ['google-api-key', /\bAIza[A-Za-z0-9_-]{8,}/],
  ['api-token', /\bsk-[A-Za-z0-9._-]{8,}/],
  // Require an actual quoted literal. Documentation mentioning "password" and
  // runtime lookups such as process.env.PASSWORD are intentionally ignored.
  ['assigned-secret', /(?:^|[^A-Za-z0-9_])(?:password|passwd|pwd|secret|token|api[_-]?key)\s*(?:=|:)\s*(["'])(?=.{8,}\1)[^\r\n]*?\1/im],
];

export function scanSecret({ filePath, content }) {
  const normalized = String(filePath).replaceAll('\\', '/');
  const types = [];
  for (const [type, pattern] of SENSITIVE_FILE_PATTERNS) if (pattern.test(normalized)) types.push(type);
  if (typeof content === 'string') {
    for (const [type, pattern] of CONTENT_PATTERNS) if (pattern.test(content)) types.push(type);
  }
  return [...new Set(types)];
}

export function scanRescuePaths(tree, paths) {
  const safePaths = [];
  const excluded = [];
  for (const filePath of [...new Set(paths)]) {
    const absolute = path.join(tree, filePath);
    let content;
    try {
      if (fs.lstatSync(absolute).isFile()) content = fs.readFileSync(absolute, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const types = scanSecret({ filePath, content });
    if (types.length) excluded.push({ path: filePath, types });
    else safePaths.push(filePath);
  }
  return { safePaths, excluded };
}
