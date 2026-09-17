#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';


export const additionalContext = '[AUTOMATION-FIRST] user 依頼(手作業/設定/コピペ/UI操作)の前に必ず順に試す: (1) MCP/CLI で取得 (2) keyserve（tools/keyserve-status.mjs / tools/env-kv.mjs）から取得 (3) production bundle から公開設定値を確認 (4) 自動設定は専用ツール経由のみ（tools/env-kv.mjs など） (5) 全部不可の時のみ理由明示で user 依頼(例外: OAuth初回同意/支払い/アカウント作成/物理操作のみ)。0ステップが原則、準備は全部Claude側で済ませる。ID/設定値も対象。classifier 拒否はカテゴリを1行報告し、言い換え再試行しない。';

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    JSON.parse(raw);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
