#!/usr/bin/env node
import { isEntry } from '../is-entry.mjs';
import { readStdinWithTimeout } from '../lib/hook-stdin.mjs';

export const HOOK_MATCHER = 'mcp__claude_ai_Google_Drive__read_file_content|mcp__claude_ai_Google_Drive__download_file_content';
export function warning(event) {
  if (!new RegExp(`^(?:${HOOK_MATCHER})$`).test(event?.tool_name ?? '')) return;
  const input = event?.tool_input;
  if (!input || typeof input.fileId !== 'string' || !input.fileId.trim()) return;
  // Metadata is usually absent: warn conservatively rather than assume non-Sheets.
  const additionalContext = '⚠️ Google スプレッドシートはこの経路だと先頭タブしか返りません。返ってこない=存在しない、と結論しないこと。全タブ確認は `node "C:\\Users\\uers\\orgiast-main\\tools\\sheet-read.mjs" <id> --tabs`、検索は `--grep`、タブ指定は `--gid`/`--tab`。';
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext } };
}
async function main() {
  try {
    const result = warning(JSON.parse(await readStdinWithTimeout()));
    if (result) console.log(JSON.stringify(result));
  } catch { /* fail open: a warning must never stop the tool */ }
}
if (isEntry(import.meta.url)) await main();
