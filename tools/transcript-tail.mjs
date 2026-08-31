import fs from 'node:fs';

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
  let latest = '';
  for (const line of readLastLines(transcriptPath)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const message = event?.message;
    if (!message || (event.type !== 'assistant' && message.role !== 'assistant') || !Array.isArray(message.content)) continue;
    latest = message.content.filter((block) => block?.type === 'text' && typeof block.text === 'string').map((block) => block.text).join('\n');
  }
  return latest;
}

export async function readStdin() {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  return input;
}
