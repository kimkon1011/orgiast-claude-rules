#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

import { isUnattendedSession } from './lib/unattended-session.mjs';
import { inboxText, inboxFile, readRows } from './lib/auto-progress-inbox.mjs';
export { inboxFile, appendInbox, appendOwnerInbox } from './lib/auto-progress-inbox.mjs';
function displayText(text, limit = 1500) {
  const seen = new Set();
  return String(text).split(/\r?\n/).filter(line => {
    if (!line.trim()) return true;
    if (seen.has(line)) return false;
    seen.add(line); return true;
  }).join('\n').slice(0, limit);
}
export function consumeInbox(input, { home = process.env.ORGIAST_HOME || os.homedir(), env = process.env } = {}) {
  if (isUnattendedSession(input, { home, env })) return null;
  const sessionId = input?.session_id || input?.sessionId; if (!sessionId) return null;
  const ownerFile = inboxFile(home, '_owner');
  const sessionFile = inboxFile(home, sessionId);
  const sessionRows = readRows(sessionFile);
  const ownerRows = readRows(ownerFile);
  const unreadSession = sessionRows.filter(row => !row.shown);
  const ids = new Set(unreadSession.map(row => row.id).filter(Boolean));
  const unreadOwner = ownerRows.filter(row => !row.shown && !ids.has(row.id))
    .sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  const lines = unreadSession.map(row => displayText(inboxText(row)));
  lines.push(...unreadOwner.slice(0, 5).map(row => String(inboxText(row)).replace(/\s+/g, ' ').slice(0, 120)));
  if (unreadOwner.length > 5) lines.push(`ほか ${unreadOwner.length - 5} 件`);
  // Overflow remains unread so its contents can be delivered on the next prompt.
  const selected = [...unreadSession, ...unreadOwner.slice(0, 5)];
  const selectedIds = new Set(selected.map(row => row.id).filter(Boolean));
  const shownAt = new Date().toISOString();
  const files = new Set([sessionFile, ownerFile]);
  for (const row of selected) {
    if (row.sessionId) files.add(inboxFile(home, row.sessionId));
  }
  for (const file of files) {
    const rows = file === sessionFile ? sessionRows : file === ownerFile ? ownerRows : readRows(file);
    let changed = false;
    const updated = rows.map(row => {
      if (row.shown || !(selectedIds.has(row.id) || selected.includes(row))) return row;
      changed = true;
      return { ...row, shown: true, shownAt, shownSession: sessionId };
    });
    if (changed) fs.writeFileSync(file, updated.map(JSON.stringify).join('\n') + '\n');
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
