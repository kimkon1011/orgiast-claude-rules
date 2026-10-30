import fs from 'node:fs';

const DEFAULT_MAX_LINES = 4000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

function tailLines(file, maxLines, maxBytes) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buffer, 0, length, stat.size - length);
  } finally {
    fs.closeSync(fd);
  }
  let raw = buffer.toString('utf8');
  if (stat.size > length) {
    const firstNewline = raw.indexOf('\n');
    raw = firstNewline < 0 ? '' : raw.slice(firstNewline + 1);
  }
  return raw.split(/\r?\n/).slice(-maxLines);
}

export function readTranscriptContext(transcriptPath, options = {}) {
  if (!transcriptPath) return { assistantText: '', humanText: '', raw: '', reason: 'no-path', scannedLines: 0 };
  let lines;
  try { lines = tailLines(transcriptPath, options.maxLines ?? DEFAULT_MAX_LINES, options.maxBytes ?? DEFAULT_MAX_BYTES); }
  catch { return { assistantText: '', humanText: '', raw: '', reason: 'unreadable', scannedLines: 0 }; }
  let assistantText = '';
  let humanText = '';
  for (let index = lines.length - 1; index >= 0 && (!assistantText || !humanText); index--) {
    let entry; try { entry = JSON.parse(lines[index]); } catch { continue; }
    if (entry?.isSidechain === true) continue;
    const content = entry?.message?.content;
    const text = Array.isArray(content)
      ? content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n')
      : typeof content === 'string' ? content : '';
    if (!assistantText && (entry?.type === 'assistant' || entry?.message?.role === 'assistant') && text.trim()) assistantText = text;
    if (!humanText && entry?.type === 'user' && !(Array.isArray(content) && content.some((block) => block?.type === 'tool_result'))) {
      const trimmed = text.trimStart();
      if (trimmed && !MACHINE_USER_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) humanText = text;
    }
  }
  return { assistantText, humanText, raw: lines.join('\n'), reason: assistantText ? 'ok' : 'no-assistant-text', scannedLines: lines.length };
}

export function readAssistantText(transcriptPath, options = {}) {
  if (!transcriptPath) return { text: '', reason: 'no-path', scannedLines: 0 };
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let lines;
  try {
    lines = tailLines(transcriptPath, maxLines, maxBytes);
  } catch {
    return { text: '', reason: 'unreadable', scannedLines: 0 };
  }
  let scannedLines = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    scannedLines++;
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if ((entry?.type !== 'assistant' && entry?.message?.role !== 'assistant') || entry?.isSidechain === true) continue;
    const content = entry?.message?.content;
    const text = Array.isArray(content)
      ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
      : typeof content === 'string' ? content : '';
    if (text.trim()) return { text, reason: 'ok', scannedLines };
  }
  return { text: '', reason: 'no-assistant-text', scannedLines };
}

export function latestAssistantText(transcriptPath, options) {
  return readAssistantText(transcriptPath, options).text;
}

const MACHINE_USER_PREFIXES = [
  '<local-command', '<command-name', '<command-message', '<command-args',
  '<task-notification', '<system-reminder', '<local-command-stdout', '[Image:',
  'Stop hook feedback:',
];

function entryText(entry) {
  const content = entry?.message?.content;
  return Array.isArray(content)
    ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
    : typeof content === 'string' ? content : '';
}

function isRealHumanEntry(entry) {
  if (entry?.isSidechain === true || entry?.isMeta === true || (entry?.type !== 'user' && entry?.message?.role !== 'user')) return false;
  const content = entry?.message?.content;
  if (Array.isArray(content) && content.some(block => block?.type === 'tool_result')) return false;
  const text = entryText(entry).trimStart();
  return !!text && !MACHINE_USER_PREFIXES.some(prefix => text.startsWith(prefix));
}

// Stop hook feedback is encoded as a user entry, but it does not start a new conversational
// turn. Keep every assistant text since the last real user request so a retry can add only the
// missing lines instead of repeating the preceding response.
export function currentTurnAssistantTexts(raw) {
  const entries = String(raw || '').split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
  let start = 0;
  entries.forEach((entry, index) => { if (isRealHumanEntry(entry)) start = index + 1; });
  return entries.slice(start).filter(entry => entry?.isSidechain !== true && (entry?.type === 'assistant' || entry?.message?.role === 'assistant'))
    .map(entryText).filter(text => text.trim());
}

export function currentTurnAssistantText(raw) {
  return currentTurnAssistantTexts(raw).join('\n\n');
}

export function readLastHumanText(transcriptPath, options = {}) {
  if (!transcriptPath) return { text: '', reason: 'no-path', scannedLines: 0 };
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let lines;
  try {
    lines = tailLines(transcriptPath, maxLines, maxBytes);
  } catch {
    return { text: '', reason: 'unreadable', scannedLines: 0 };
  }
  let scannedLines = 0;
  for (let index = lines.length - 1; index >= 0; index--) {
    scannedLines++;
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    if (entry?.type !== 'user' || entry?.isSidechain === true) continue;
    const content = entry?.message?.content;
    if (Array.isArray(content) && content.some(block => block?.type === 'tool_result')) continue;
    const text = Array.isArray(content)
      ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n')
      : typeof content === 'string' ? content : '';
    const trimmed = text.trimStart();
    if (!trimmed || MACHINE_USER_PREFIXES.some(prefix => trimmed.startsWith(prefix))) continue;
    return { text, reason: 'ok', scannedLines };
  }
  return { text: '', reason: 'no-human-text', scannedLines };
}
