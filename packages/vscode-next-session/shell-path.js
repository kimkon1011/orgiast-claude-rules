const fs = require('node:fs');
const path = require('node:path');

function resolveClaudeShellPath(candidate, existsSync = fs.existsSync, pathApi = path) {
  if (!candidate) return { shellPath: 'claude', ignored: false };
  const basename = pathApi.basename(candidate).toLowerCase();
  const validName = basename === 'claude' || basename === 'claude.exe';
  if (pathApi.isAbsolute(candidate) && validName && existsSync(candidate)) {
    return { shellPath: candidate, ignored: false };
  }
  return { shellPath: 'claude', ignored: true };
}

module.exports = { resolveClaudeShellPath };
