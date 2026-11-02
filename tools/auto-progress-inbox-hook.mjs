#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

import { inboxFile, readRows } from './lib/auto-progress-inbox.mjs';
export { inboxFile, appendInbox, appendOwnerInbox } from './lib/auto-progress-inbox.mjs';
function displayText(text, limit = 1500) {
  const seen = new Set();
  return String(text).split(/\r?\n/).filter(line => {
    if (!line.trim()) return true;
    if (seen.has(line)) return false;
    seen.add(line); return true;
  }).join('\n').slice(0, limit);
}
export function consumeInbox(input, { home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  const sessionId = input?.session_id || input?.sessionId; if (!sessionId) return null;
  const files = [...new Set([inboxFile(home, sessionId), inboxFile(home, '_owner')])];
  const lines = [];
  const shownAt = new Date().toISOString();
  for (const file of files) {
    const rows = readRows(file);
    const unread = rows.filter(row => !row.shown);
    if (!unread.length) continue;
    fs.writeFileSync(file, rows.map(row => JSON.stringify(row.shown ? row : { ...row, shown: true, shownAt, shownSession: sessionId })).join('\n') + '\n');
    if (file === inboxFile(home, '_owner')) {
      const latest = unread.reduce((a, b) => Date.parse(a.at) > Date.parse(b.at) ? a : b);
      lines.push(displayText(latest.text));
      if (unread.length > 1) lines.push(`ほか ${unread.length - 1} 件（古い通知）`);
    } else {
      lines.push(...unread.map(row => displayText(`${row.state || 'progressed'}: ${row.evidence || ''}${row.artifact ? `（成果物: ${row.artifact}）` : ''}`)));
    }
  }
  if (!lines.length) return null;
  const event = input.hook_event_name || 'UserPromptSubmit';
  return { hookSpecificOutput: { hookEventName: event, additionalContext: `【必須】応答の冒頭で user に見える形で「📲 自動進行の結果（聞かれる前にお知らせ）」として次を表示せよ: ${displayText(lines.join('\n'), Infinity)}` } };
}
async function main() {
  try {
    const input = JSON.parse(await readStdinWithTimeout());
    const out = consumeInbox(input);
    const { sessionDigest } = await import('./auto-progress-digest.mjs');
    const digest = sessionDigest();
    if (digest) {
      const context = `【進捗まとめ】以下を応答で提示する（最大5件・1件1行）。\n${digest}`;
      if (out) out.hookSpecificOutput.additionalContext += '\n' + context;
      else { console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: input.hook_event_name || 'UserPromptSubmit', additionalContext: context } })); return; }
    }
    if (out) console.log(JSON.stringify(out));
  } catch (error) { console.error(`auto-progress-inbox: ${error.message}`); }
}
if (isEntry(import.meta.url)) await main();
