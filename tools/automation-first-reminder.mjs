#!/usr/bin/env node
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';


export const additionalContext = '[AUTOMATION-FIRST] user 依頼(手作業/設定/コピペ/UI操作)の前に必ず順に試す: (1) MCP/CLI で取得 (2) 過去 transcript / .env.local から復元(Claude Grep tool、bash grep は classifier NG) (3) production bundle から抽出 (4) 自動設定(vercel env add / gh secret set / db push / .env.local 直書き)。(5) 全部不可の時のみ理由明示で user 依頼(例外: OAuth初回同意/支払い/アカウント作成/物理操作のみ)。0ステップが原則、「最後の1ステップだけ user に」も禁止。ID/設定値も対象。詳細: ~/.claude/projects/c--Users-uers-Downloads-CLAUDE-md--/memory/feedback_max_automation_minimum_handoff.md';

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    JSON.parse(raw);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } }));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
