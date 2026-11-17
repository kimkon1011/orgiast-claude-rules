#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

export const GATE_CONTRACT = {"name":"calendar-external-guest-gate","remedies":[{"kind":"repo-file","ref":"tools/gate-remedies.md","section":"calendar-external-guest-gate"}]};
export const HOOK_MATCHER = 'mcp__.*(?:[Cc]alendar|gcal).*|Bash|PowerShell';
const CALENDAR_TOOLS = /^mcp__.*(?:calendar|gcal).*?(?:create|update|respond|insert|patch)/i;
export const BLOCK_REASON = '社外の人は社内カレンダーの招待者に入れない。お客様への案内はメール本文に日時と会議URLを書く。';
const ADDRESS = /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
function internal(email) {
  const staff = JSON.parse(fs.readFileSync(new URL('../config/staff-addresses.json', import.meta.url), 'utf8')).addresses;
  return /^[^@\s<>]+@orgiast\.jp$/i.test(email) || staff.some(a => a.toLowerCase() === email.toLowerCase());
}
function collect(value, guest = false) {
  if (value == null) return [];
  if (typeof value === 'string') {
    if (guest) return value.match(ADDRESS) || (value.trim() ? ['未解決の参加者'] : []);
    try { return collect(JSON.parse(value)); } catch { return []; }
  }
  if (Array.isArray(value)) return value.flatMap(v => collect(v, guest));
  if (typeof value === 'object') return Object.entries(value).flatMap(([key, v]) =>
    collect(v, /^(attendees?|guests?|emails?)$/i.test(key) || (guest && key === 'email')));
  return guest ? ['未解決の参加者'] : [];
}
export function judge(input) {
  const tool = input?.tool_name || '';
  const args = input?.tool_input || {};
  const shell = /^(Bash|PowerShell)$/.test(tool);
  if (!shell && !CALENDAR_TOOLS.test(tool)) return { decision: 'pass' };
  try {
    let emails;
    if (shell) {
      const command = String(args.command || args.script || '');
      const calendar = /googleapis\.com\/calendar\/|\bcalendar["']?\s*(?:\([^)]*\))?\s*[.\/]|["']calendar["']|\bgcal(?:cli)?\b|\bgws\s+calendar\b|\bcalendar[-_][\w.-]+/i.test(command);
      const write = /\b(insert|patch|update|create|respond|add|POST|PUT|PATCH)\b|--(?:attendees?|guests?)|["']?attendees["']?\s*[:=]/i.test(command);
      if (!calendar || !write) return { decision: 'pass' };
      // Shell payloads may come from files/variables. Do not treat an opaque write as verified safe.
      emails = command.match(ADDRESS) || [];
      if ((/-d\s+[@$]|--(?:attendees?|guests?)\s+[$@]/i.test(command) || /attendees?[^\n]{0,40}[:=]\s*[$@]|--(?:body|json|data)(?:-file)?\s|(?:body|requestBody|json)\s*[:=]\s*[$a-z_]/i.test(command) || !emails.length) && /attendees?|guests?|--(?:body|json|data)|-d\b|(?:body|requestBody|json)\s*[:=]|@\w+\.json/i.test(command)) emails = ['未解決の参加者'];
    } else emails = collect(args);
    for (const email of emails) {
      if (!internal(email)) return { decision: 'block', reason: `[CALENDAR-EXTERNAL-GUEST] ${email}: ${BLOCK_REASON}` };
    }
    return { decision: 'pass' };
  } catch {
    return { decision: 'block', reason: `[CALENDAR-EXTERNAL-GUEST] 参加者を検証できません。${BLOCK_REASON}` };
  }
}
async function main() {
  try {
    const raw = await readStdinWithTimeout(4000);
    if (!raw.trim()) return;
    const result = judge(JSON.parse(raw));
    if (result.decision === 'block') console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: result.reason } }));
  } catch {
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: BLOCK_REASON } }));
  }
}
if (isEntry(import.meta.url)) await main();
