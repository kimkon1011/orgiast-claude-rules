import fs from 'node:fs';
import { latestAssistantText } from './lib/assistant-text.mjs';

export function readLastLines(file, count = 50, maxBytes = 256 * 1024) {
  const stat = fs.statSync(file);
  const length = Math.min(stat.size, maxBytes);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  try { fs.readSync(fd, buffer, 0, length, stat.size - length); } finally { fs.closeSync(fd); }
  let raw = buffer.toString('utf8');
  if (stat.size > length) raw = raw.slice(raw.indexOf('\n') + 1);
  return raw.split(/\r?\n/).slice(-count);
}

export function lastAssistantText(transcriptPath) {
  return latestAssistantText(transcriptPath);
}

export async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}
