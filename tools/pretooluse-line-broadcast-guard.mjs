#!/usr/bin/env node
export const GATE_CONTRACT = {"name":"pretooluse-line-broadcast-guard","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"pretooluse-line-broadcast-guard"}]};
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

const TARGET = /(?:api\.line\.me)?\/v2\/bot\/message\/(?:broadcast|narrowcast)/i;
const ALLOW = '[LINE-BROADCAST-OK]';
const REASON = 'LINE の broadcast/narrowcast は友だち全員に届き、宛先の身元を API で確認できません（未認証アカウントは followers/ids が 403。友だち数は身元の証拠になりません）。userId を指定した push（claude-mobile/scripts/line-send.mjs）で送ってください。kim が同じセッションで全員配信を明示した場合だけ、応答に [LINE-BROADCAST-OK] と書いてから再実行できます。';

function assistantText(record) {
  if (record?.type !== 'assistant' && record?.message?.role !== 'assistant' && record?.role !== 'assistant') return '';
  const content = record?.message?.content ?? record?.content ?? '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((part) => part?.type === 'text' || typeof part === 'string').map((part) => typeof part === 'string' ? part : String(part.text || '')).join('\n');
}

function transcriptAllows(file) {
  if (!file) return false;
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).some((line) => {
      try { return assistantText(JSON.parse(line)).includes(ALLOW); } catch { return false; }
    });
  } catch { return false; }
}

function inspectedText(input) {
  const tool = String(input?.tool_name || '');
  if (!/^(Bash|PowerShell|Write|Edit|MultiEdit)$/.test(tool)) return '';
  const toolInput = input?.tool_input || {};
  const values = [toolInput.command, toolInput.content, toolInput.new_string];
  if (tool === 'MultiEdit' && Array.isArray(toolInput.edits)) values.push(...toolInput.edits.map((edit) => edit?.new_string));
  return values.filter((value) => typeof value === 'string').join('\n');
}

export function evaluateLineBroadcastGuard(input) {
  if (!TARGET.test(inspectedText(input)) || transcriptAllows(input?.transcript_path)) return null;
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: REASON } };
}

async function main() {
  try {
    const output = evaluateLineBroadcastGuard(JSON.parse(await readStdinWithTimeout()));
    if (output) console.log(JSON.stringify(output));
  } catch {}
}

if (isEntry(import.meta.url)) await main();
