#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { isEntry } from './is-entry.mjs';
import { hasJournalMarker, journalDir, journalHome, markJournal, promptText, transcriptPath, validId } from './prompt-journal.mjs';

const GRACE_MS = 2 * 60_000;
const journalDate = /^\d{4}-\d\d-\d\d\.jsonl$/;

function entries(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
}

export function hasPendingPrompts(home, session) {
  return entries(path.join(journalDir(home), 'pending', session)).some(file =>
    file.isFile() && validId(file.name) && !hasJournalMarker(home, session, file.name, 'handled'));
}

async function* rows(file) {
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      try { yield JSON.parse(line.replace(/^\uFEFF/, '')); } catch { /* Incomplete or malformed JSONL row. */ }
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    lines.close();
    stream.destroy();
  }
}

function userText(row, session) {
  if (row?.type !== 'user' || row.sessionId !== session || row.isSidechain || row.isMeta) return;
  const content = row.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content) && !content.some(block => block?.type === 'tool_result')) {
    const text = content.filter(block => block?.type === 'text' && typeof block.text === 'string');
    if (text.length) return text.map(block => block.text).join('\n');
  }
}

export async function findLostPrompts({ home = journalHome(), now = Date.now(), sessionId, transcript, graceMs = GRACE_MS, pendingOnly = false } = {}) {
  const dir = journalDir(home);
  const sessions = new Map();
  for (const file of entries(dir).filter(file => file.isFile() && journalDate.test(file.name))) {
    for await (const row of rows(path.join(dir, file.name))) {
      if (!validId(row?.session_id) || !validId(row.id) || typeof row.prompt !== 'string'
        || !Number.isFinite(Date.parse(row.at)) || (sessionId && row.session_id !== sessionId)) continue;
      if (!sessions.has(row.session_id)) sessions.set(row.session_id, []);
      sessions.get(row.session_id).push(row);
    }
  }
  if (!sessions.size) return [];
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'projects');
  const projectDirs = entries(projects).filter(item => item.isDirectory()).map(item => path.join(projects, item.name));
  const lost = [];
  for (const [session, journal] of sessions) {
    const files = new Set(journal.map(row => transcriptPath(row.transcript_path, session)).filter(Boolean));
    if (transcriptPath(transcript, session)) files.add(transcript);
    for (const project of projectDirs) {
      const file = path.join(project, session + '.jsonl');
      if (fs.existsSync(file)) files.add(file);
    }

    // Each transcript occurrence accounts for one submission, even for repeated text.
    const submitted = new Map();
    for (const row of journal.sort((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
      if (!submitted.has(row.prompt)) submitted.set(row.prompt, []);
      submitted.get(row.prompt).push(row);
    }
    const recorded = new Map();
    const seen = new Set();
    for (const file of files) {
      for await (const row of rows(file)) {
        const text = userText(row, session);
        const time = Date.parse(row?.timestamp);
        if (text === undefined || !Number.isFinite(time) || (row.uuid && seen.has(row.uuid))) continue;
        const normalized = promptText(text);
        if (!submitted.has(normalized)) continue;
        if (row.uuid) seen.add(row.uuid);
        if (!recorded.has(normalized)) recorded.set(normalized, []);
        recorded.get(normalized).push(time);
      }
    }
    for (const [prompt, submissions] of submitted) {
      const times = (recorded.get(prompt) || []).sort((a, b) => a - b);
      // Pair newest first so a successful resend cannot hide an earlier loss.
      for (const row of submissions.reverse()) {
        const at = Date.parse(row.at);
        if (times.length && times.at(-1) >= at) times.pop();
        else if ((pendingOnly ? hasJournalMarker(home, session, row.id, 'pending') : at <= now - graceMs)
          && !hasJournalMarker(home, session, row.id, 'handled')) lost.push(row);
      }
    }
  }
  return lost.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export async function scanLostPrompts({ home = journalHome(), ...options } = {}) {
  const lost = await findLostPrompts({ home, ...options });
  if (!lost.length) return 0;
  const { addItem } = await import('./kim-inbox.mjs');
  for (const row of lost) {
    if (hasJournalMarker(home, row.session_id, row.id, 'handled')) continue;
    markJournal(home, row.session_id, row.id, 'pending');
    await addItem(home, {
      kind: 'info', source: 'lost-prompt-scan', sessionId: row.session_id, dedupeKey: 'lost-prompt:' + row.id,
      text: `Claude Code 未達の返答 (${row.session_id})\n${[...row.prompt].slice(0, 80).join('')}`,
    }, { drain: false, localOnly: true });
  }
  return lost.length;
}

if (isEntry(import.meta.url)) {
  try { console.log(`lost-prompt-scan: ${await scanLostPrompts()} unmatched`); }
  catch { console.error('lost-prompt-scan: scan failed'); process.exitCode = 1; }
}
