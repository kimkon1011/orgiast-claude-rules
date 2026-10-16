#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

const reason = '[CLAUDE-DOCS-GUARD] 文書は Google ドキュメントで作る（kim 2026-10-08 ルール）。claude.ai の URL は他メンバーが開けない。Drive create_file（contentMimeType: text/html → Google Doc に自動変換）で案件フォルダに作り、get_file_permissions で orgiast.jp ドメイン閲覧を確認し、docs.google.com/a/orgiast.jp/document/d/{ID}/edit で渡す。例外は user が明示的に Claude Docs を指定したときだけ。';

export async function main() {
  try {
    const input = JSON.parse((await readStdinWithTimeout()).replace(/^\uFEFF/, ''));
    const container = input?.tool_input?.container;
    const creates = input?.tool_name === 'mcp__claude_ai_Claude_Docs__create'
      || (input?.tool_name === 'mcp__claude_ai_Claude_Docs__batch'
        && container !== null && typeof container === 'object' && !Array.isArray(container)
        && Object.hasOwn(container, 'create'));
    if (creates) console.log(JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
    } }));
  } catch { /* Unexpected input fails open, matching existing hooks. */ }
}

if (isEntry(import.meta.url)) await main();
