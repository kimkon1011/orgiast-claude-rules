import fs from 'node:fs';
import path from 'node:path';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n');
}

function isUserRequest(entry) {
  if (entry?.type !== 'user' || entry?.message?.role !== 'user') return false;
  const content = entry.message.content;
  if (Array.isArray(content) && content.length && content.every(part => part?.type === 'tool_result')) return false;
  const text = textOf(content).trim();
  return Boolean(text) && !text.startsWith('<');
}

export function isSyntheticApiError(entry) {
  return entry?.type === 'assistant' && entry?.message?.role === 'assistant' &&
    (entry?.isApiErrorMessage === true || entry?.message?.model === '<synthetic>');
}

function readTail(file, maxBytes = 512 * 1024) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, stat.size - length); } finally { fs.closeSync(fd); }
  const text = buffer.toString('utf8');
  return stat.size > length ? text.slice(text.indexOf('\n') + 1) : text;
}

export function findUnansweredRequest(transcriptPath, { readFile = readTail } = {}) {
  let raw;
  try { raw = readFile(transcriptPath); } catch { return null; }
  const entries = [];
  for (const line of String(raw).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry?.isSidechain) entries.push(entry);
    } catch { /* 壊れた行は無視する。 */ }
  }
  let userIndex = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (isUserRequest(entries[i])) { userIndex = i; break; }
  }
  if (userIndex < 0) return null;
  const after = entries.slice(userIndex + 1).filter(entry => entry?.type === 'assistant');
  if (!after.length || after.some(entry => !isSyntheticApiError(entry))) return null;
  const errorEntry = after.at(-1);
  const userEntry = entries[userIndex];
  const requestText = textOf(userEntry.message.content).replace(/\s+/g, ' ').trim().slice(0, 200);
  const errorAt = errorEntry?.timestamp || userEntry?.timestamp || '';
  if (!requestText || !Number.isFinite(Date.parse(errorAt))) return null;
  return {
    sessionId: path.basename(transcriptPath, '.jsonl'),
    cwd: userEntry?.cwd || entries.findLast(entry => entry?.cwd)?.cwd || '',
    transcriptPath,
    requestText,
    errorAt,
    error: errorEntry?.error || '',
    apiError: errorEntry?.apiError || '',
    apiErrorStatus: errorEntry?.apiErrorStatus ?? '',
  };
}

export function errorKind(found) {
  return [found?.error, found?.apiError, found?.apiErrorStatus].filter(value => value !== '' && value != null).join(' / ') || 'unknown';
}

