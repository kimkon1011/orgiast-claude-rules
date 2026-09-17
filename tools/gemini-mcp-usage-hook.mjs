#!/usr/bin/env node
import fs from 'node:fs';
import { isEntry } from './is-entry.mjs';
import { geminiUsage, recordGeminiUsage } from './gemini-usage-ledger.mjs';

export function recordGeminiMcpEvent(event, { recordImpl = recordGeminiUsage } = {}) {
  if (!/^mcp__gemini-cli__(?:ask-gemini|geminiChat|googleSearch)$/.test(event?.tool_name || '')) return null;
  const response = event.tool_response?.structuredContent ?? event.tool_response ?? {};
  const usage = geminiUsage(response);
  try {
    return recordImpl({
      model: response.modelVersion || response.model || event.tool_input?.model || 'unknown',
      ...usage, source: 'mcp', tool: event.tool_name, toolUseId: event.tool_use_id,
      status: event.hook_event_name === 'PostToolUseFailure' || response.isError ? 'error' : 'ok',
      // CLI-backed MCP tools can perform hidden searches/retries. No invented token counts.
      searchCalls: response.candidates?.[0]?.groundingMetadata?.webSearchQueries?.length
        ?? (event.tool_name.endsWith('__googleSearch') ? null : 0),
    });
  } catch { return null; }
}
if (isEntry(import.meta.url)) {
  try { recordGeminiMcpEvent(JSON.parse(fs.readFileSync(0, 'utf8'))); } catch {}
}
