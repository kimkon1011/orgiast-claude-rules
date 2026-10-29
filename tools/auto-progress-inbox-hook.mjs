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
function readRows(file) {
  try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { return []; }
}
export function appendOwnerInbox(home, { source, text }) {
  const file = inboxFile(home, '_owner');
  const now = Date.now();
  if (readRows(file).some(row => !row.shown && row.text === text && now >= Date.parse(row.at) && now - Date.parse(row.at) < 24 * 60 * 60 * 1000)) return file;
  return appendInbox(home, '_owner', { at: new Date(now).toISOString(), source, text });
}
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
async function main() { try { const out = consumeInbox(JSON.parse(await readStdinWithTimeout())); if (out) console.log(JSON.stringify(out)); } catch {} }
if (isEntry(import.meta.url)) await main();
