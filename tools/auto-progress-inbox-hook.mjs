#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { readStdinWithTimeout } from './lib/hook-stdin.mjs';

export const inboxFile = (home, sessionId) => path.join(home, '.claude', 'auto-progress-inbox', `${sessionId}.jsonl`);
export function appendInbox(home, sessionId, item) {
  const file = inboxFile(home, sessionId); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify({ ...item, shown: false })}\n`); return file;
}
export function consumeInbox(input, { home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  const sessionId = input?.session_id || input?.sessionId; if (!sessionId) return null;
  const file = inboxFile(home, sessionId); let rows;
  try { rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { return null; }
  const unread = rows.filter(row => !row.shown); if (!unread.length) return null;
  fs.writeFileSync(file, rows.map(row => JSON.stringify(row.shown ? row : { ...row, shown: true, shownAt: new Date().toISOString() })).join('\n') + '\n');
  const event = input.hook_event_name || 'UserPromptSubmit';
  const lines = unread.map(row => `${row.state || 'progressed'}: ${row.evidence || ''}${row.artifact ? `（成果物: ${row.artifact}）` : ''}`);
  return { hookSpecificOutput: { hookEventName: event, additionalContext: `【必須】応答の冒頭で user に見える形で「📲 自動進行の結果: ${lines.join(' / ')}」と報告せよ。` } };
}
async function main() { try { const out = consumeInbox(JSON.parse(await readStdinWithTimeout())); if (out) console.log(JSON.stringify(out)); } catch {} }
if (isEntry(import.meta.url)) await main();
