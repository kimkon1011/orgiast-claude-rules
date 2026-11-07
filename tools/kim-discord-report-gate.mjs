#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"kim-discord-report-gate","remedies":[{"kind":"repo-file","ref":"tools/kim-inbox.mjs"}]};
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { isEntry } from './is-entry.mjs';
export const HOOK_MATCHER = 'mcp__claude_ai_Discord[^|]*__(send_dm|send_message|reply_message)|Bash|PowerShell';
const target = new RegExp(`^(?:${HOOK_MATCHER})$`);
const reason = 'kim 宛 Discord DM は全廃・例外なし（緊急を含む、kim 2026-11-06・全PC）。node tools/kim-inbox.mjs --add --kind ask|info --body-file <f> でセッション報告へ。';
export function judge(input, options = {}) {
  if (!target.test(input?.tool_name ?? '')) return { decision: 'pass' };
  const args = input.tool_input ?? {};
  let blocked = false;
  const shell = /^(Bash|PowerShell)$/.test(input.tool_name);
  const text = String(shell ? args.command ?? args.script ?? '' : args.content ?? args.message ?? args.text ?? args.body ?? '');
  if (shell) {
    if (/--dry-run\b/.test(text) || /(?:^|[\s;&|])(?:node(?:\.exe)?|"[^"\n]*node(?:\.exe)?")\s+["']?[^\s;&|]*\b(?:notify-kim|discord-dm|kim-inbox)\.mjs(?:["']|\s|$)/i.test(text)) return { decision: 'pass' };
    blocked = /discord\.com\/api|discordapp\.com|orgiast-discord-webhook\.txt/i.test(text) && /715210673642012733|1508437329247862794|orgiast-discord-(?:webhook|user-id)\.txt/.test(text);
  } else if (input.tool_name.endsWith('__send_dm')) {
    blocked = ['715210673642012733', '金功勇', 'kim'].includes(String(args.user_id ?? args.recipient_id ?? args.user ?? args.recipient ?? '').toLowerCase());
  } else blocked = String(args.channel_id ?? '') === '1508437329247862794';
  return blocked ? { decision: 'block', reason } : { decision: 'pass' };
}
export async function main() {
  try {
    const result = judge(JSON.parse(await readStdinWithTimeout(100)));
    if (result.decision === 'block') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
  } catch (error) { console.error(`kim-discord-report-gate: ${String(error.message).replace(/[\r\n]+/g, ' ')}`); }
}
if (isEntry(import.meta.url)) await main();
