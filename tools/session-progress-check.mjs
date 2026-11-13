#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { isEntry } from './is-entry.mjs';
import { footerValues, SESSION_PHRASES } from './next-action-gate.mjs';

// Completion is determined only by the latest final response, never by elapsed time.
export function sessionProgressCheck(session, { home = process.env.ORGIAST_HOME || os.homedir() } = {}) {
  if (!/^[a-zA-Z0-9_-]+$/.test(session || '')) return 1;
  const find = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && entry.name === `${session}.jsonl`) return file;
      if (entry.isDirectory() && entry.name !== 'subagents') {
        const found = find(file);
        if (found) return found;
      }
    }
  };
  try {
    const file = find(path.join(home, '.claude', 'projects'));
    if (!file) return 1;
    let finalText = '';
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.isSidechain === true || (entry.type !== 'assistant' && entry.message?.role !== 'assistant')) continue;
      const content = entry.message?.content;
      if (Array.isArray(content) && content.some(block => block.type === 'tool_use')) continue;
      const text = typeof content === 'string' ? content : Array.isArray(content)
        ? content.filter(block => block.type === 'text').map(block => block.text || '').join('\n') : '';
      if (text.trim()) finalText = text;
    }
    // Normalize transcript text as well as JSONL record separators on Windows.
    const sessionState = footerValues(finalText.replace(/\r\n/g, '\n'))?.session;
    return [SESSION_PHRASES.closed, SESSION_PHRASES.delete].includes(sessionState) ? 0 : 1;
  } catch { return 1; }
}

if (isEntry(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { session: { type: 'string' } } });
    process.exitCode = sessionProgressCheck(values.session);
  } catch { process.exitCode = 1; }
}
