// kim が「外してよい」と判断した MCP サーバーを、セットアップ・自動修復が再登録しないための除外リスト。
// ~/.claude/mcp-optout.json: { "disabled": ["gemini-cli"], "reason": "...", "decidedAt": "..." }
// 2026-11-19 実測: 09:55 に外した gemini-cli が 10:07 の register-hooks 全体実行で再登録され、
// 「外してよいか」の質問が別セッションから繰り返された。
import fs from 'node:fs';
import path from 'node:path';

export const mcpOptoutFile = home => path.join(home, '.claude', 'mcp-optout.json');
export function disabledMcpServers(home) {
  try {
    const value = JSON.parse(fs.readFileSync(mcpOptoutFile(home), 'utf8').replace(/^\uFEFF/, ''));
    return new Set((Array.isArray(value?.disabled) ? value.disabled : []).filter(name => typeof name === 'string'));
  } catch { return new Set(); }
}
export const isMcpOptedOut = (home, name) => disabledMcpServers(home).has(name);
