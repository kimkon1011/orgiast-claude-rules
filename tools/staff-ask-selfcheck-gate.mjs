#!/usr/bin/env node
export const GATE_CONTRACT = { name: 'staff-ask-selfcheck-gate', remedies: [{ kind: 'repo-file', ref: 'tools/gate-remedies.md', section: 'staff-ask-selfcheck-gate' }] };
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';
import { findOutsourcedInvestigation, scanToolUses } from './self-check-before-asking-guard.mjs';

const DIRECT_SEND = /(?:Discord.*__(?:send_message|reply_message|send_dm)|Slack.*__(?:send_message|post_message)|Gmail__(?:send_message|create_draft|reply))$/i;
const CLI_SEND = /tools[\\/](?:fleet-mail\.mjs|line-send[^\s"']*)/i;

function firstString(input, keys) {
  for (const key of keys) if (typeof input?.[key] === 'string' && input[key].trim()) return input[key];
  return '';
}

export function extractBody(toolName, toolInput, cwd = process.cwd()) {
  if (DIRECT_SEND.test(String(toolName || ''))) return firstString(toolInput, ['content', 'body', 'text', 'message']);
  if (!/^(?:Bash|PowerShell)$/.test(String(toolName || ''))) return '';
  const command = firstString(toolInput, ['command', 'cmd']);
  if (!CLI_SEND.test(command)) return '';
  const match = command.match(/--body-file(?:=|\s+)(?:"([^"]+)"|'([^']+)'|([^\s]+))/i);
  if (!match) return '';
  const file = path.resolve(cwd, match[1] || match[2] || match[3]);
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

export function judge(toolName, toolInput, evidence, cwd) {
  const text = extractBody(toolName, toolInput, cwd);
  if (!text) return null;
  return findOutsourcedInvestigation(text, evidence, { staffQuestions: true, requireRelevantEvidence: true });
}

export function formatStaffViolation(result) {
  const source = result?.sources?.[0];
  return source ? `[STAFF-SELFCHECK] 社員に聞く前に自分で調べる: ${source.key} は ${source.how} で照会できる。照会してから、人にしか分からない事だけを聞く` : '';
}

async function main() {
  try {
    const raw = await readStdinWithTimeout();
    if (!raw.trim()) return;
    const input = JSON.parse(raw);
    const evidence = input.transcript_path && fs.existsSync(input.transcript_path) ? scanToolUses(input.transcript_path) : { names: new Set(), inputs: '' };
    const result = judge(input.tool_name, input.tool_input, evidence, input.cwd);
    if (!result) return;
    console.error(formatStaffViolation(result));
    process.exitCode = 2;
  } catch { /* fail open */ }
}

if (isEntry(import.meta.url)) await main();
