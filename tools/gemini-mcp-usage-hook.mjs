#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { isEntry } from './is-entry.mjs';
import { geminiHome, geminiUsage, recordGeminiUsage } from './gemini-usage-ledger.mjs';

const TAIL_BYTES = 64 * 1024;
const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

function tailText(file, fsImpl) {
  const size = fsImpl.statSync(file).size;
  if (size <= TAIL_BYTES) return fsImpl.readFileSync(file, 'utf8');
  const buffer = Buffer.alloc(TAIL_BYTES);
  const fd = fsImpl.openSync(file, 'r');
  try { fsImpl.readSync(fd, buffer, 0, buffer.length, size - buffer.length); }
  finally { fsImpl.closeSync(fd); }
  const text = buffer.toString('utf8');
  const firstNewline = text.indexOf('\n');
  return firstNewline < 0 ? '' : text.slice(firstNewline + 1);
}

export function findRecentGeminiChatUsage({ home = geminiHome(), fsImpl = fs, now = new Date(), windowMs = 120000, responseText = '' } = {}) {
  const nowMs = new Date(now).getTime();
  const cutoff = nowMs - windowMs;
  const candidates = [];
  const root = path.join(home, '.gemini', 'tmp');
  let projects;
  try { projects = fsImpl.readdirSync(root, { withFileTypes: true }); } catch { return null; }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    const chats = path.join(root, project.name, 'chats');
    let files;
    try { files = fsImpl.readdirSync(chats, { withFileTypes: true }); } catch { continue; }
    for (const entry of files) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = path.join(chats, entry.name);
      try {
        if (fsImpl.statSync(file).mtimeMs < cutoff) continue;
        const lines = tailText(file, fsImpl).split(/\r?\n/);
        for (let index = lines.length - 1; index >= 0; index--) {
          let row;
          try { row = JSON.parse(lines[index]); } catch { continue; }
          if (row?.type !== 'gemini' || !row.tokens) continue;
          const timestamp = new Date(row.timestamp).getTime();
          if (!Number.isFinite(timestamp) || timestamp < cutoff || timestamp > nowMs) continue;
          const input = tokenCount(row.tokens.input);
          const output = tokenCount(row.tokens.output);
          const thoughts = tokenCount(row.tokens.thoughts);
          if (input === null || output === null || thoughts === null) continue;
          candidates.push({
            model: typeof row.model === 'string' ? row.model : undefined,
            inTokens: input,
            outTokens: output + thoughts,
            cachedTokens: tokenCount(row.tokens.cached),
            content: typeof row.content === 'string' ? row.content.trim() : '',
            timestamp,
          });
        }
      } catch {}
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b.timestamp - a.timestamp);
  const matching = responseText && candidates.find((candidate) => candidate.content && responseText.includes(candidate.content));
  const { content: _content, timestamp: _timestamp, ...usage } = matching || candidates[0];
  return usage;
}

function responseText(response) {
  if (typeof response === 'string') return response;
  if (!Array.isArray(response?.content)) return '';
  return response.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('\n');
}

export function recordGeminiMcpEvent(event, { recordImpl = recordGeminiUsage, home = geminiHome(), fsImpl = fs, now = new Date(), windowMs = 120000 } = {}) {
  if (!/^mcp__gemini-cli__(?:ask-gemini|geminiChat|googleSearch)$/.test(event?.tool_name || '')) return null;
  const response = event.tool_response?.structuredContent ?? event.tool_response ?? {};
  let usage = geminiUsage(response);
  let fallback = null;
  if (usage.inTokens === null || usage.outTokens === null) {
    const responseBody = responseText(event.tool_response);
    fallback = findRecentGeminiChatUsage({ home, fsImpl, now, windowMs, responseText: responseBody });
    if (fallback) usage = fallback;
  }
  try {
    return recordImpl({
      model: fallback?.model || response.modelVersion || response.model || event.tool_input?.model || 'unknown',
      ...usage, source: 'mcp', tool: event.tool_name, toolUseId: event.tool_use_id,
      status: event.hook_event_name === 'PostToolUseFailure' || response.isError ? 'error' : 'ok',
      // CLI-backed MCP tools can perform hidden searches/retries. No invented token counts.
      searchCalls: response.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length
        ?? (event.tool_name.endsWith('__googleSearch') ? null : 0),
    }, { home, fsImpl, now });
  } catch { return null; }
}
if (isEntry(import.meta.url)) {
  try { recordGeminiMcpEvent(JSON.parse(fs.readFileSync(0, 'utf8'))); } catch {}
}
