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
