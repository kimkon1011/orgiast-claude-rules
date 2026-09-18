import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DEFAULT_PRICING_FILE, geminiUsage, recordGeminiUsage } from './gemini-usage-ledger.mjs';
import { recordGeminiMcpEvent } from './gemini-mcp-usage-hook.mjs';
import { memoryFs } from './gemini-test-fs.mjs';

const home = path.resolve('/mock-gemini-home');
const file = path.join(home, '.claude', 'executor-usage.jsonl');
const now = new Date('2026-09-14T00:00:00Z');
const pricing = { models: { known: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1, batchMultiplier: 0.5, searchUsdPerCall: 0.01 } } };
const input = { model: 'known', inTokens: 100, outTokens: 50, source: 'llm-ask' };

test('unknown model appends usd:null and pricing:unknown in the required row format', () => {
  const fsImpl = memoryFs({ [file]: '{"existing":true}\n' });
  const row = recordGeminiUsage({ ...input, model: 'unlisted' }, { home, now, fsImpl, pricing });
  assert.deepEqual(row, { t: now.toISOString(), provider: 'gemini', model: 'unlisted', in: 100, out: 50, usd: null, source: 'llm-ask', searches: 0, pricing: 'unknown' });
  assert.equal(fsImpl.files.get(file), `{"existing":true}\n${JSON.stringify(row)}\n`);
  assert.deepEqual(fsImpl.writes, [file]);
});
test('native usage includes thinking; compatible usage does not double count reasoning', () => {
  assert.deepEqual(geminiUsage({ usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 30, cachedContentTokenCount: 10 } }), { inTokens: 100, outTokens: 50, cachedTokens: 10 });
  assert.deepEqual(geminiUsage({ usage: { prompt_tokens: 100, completion_tokens: 50, completion_tokens_details: { reasoning_tokens: 30 } } }), { inTokens: 100, outTokens: 50, cachedTokens: 0 });
});
test('missing and invalid tokens stay null and estimated, never character estimates', () => {
  for (const value of [undefined, null, -1, NaN, '100']) {
    const row = recordGeminiUsage({ ...input, inTokens: value, outTokens: value }, { home, now, fsImpl: memoryFs(), pricing });
    assert.equal(row.in, null); assert.equal(row.out, null); assert.equal(row.usd, null); assert.equal(row.estimated, true);
  }
});
test('reads override, falls back only if absent, and rejects expired or invalid rates', () => {
  const override = path.join(home, '.claude', 'gemini-pricing.json');
  for (const target of [override, DEFAULT_PRICING_FILE]) {
    const row = recordGeminiUsage(input, { home, now, fsImpl: memoryFs({ [target]: JSON.stringify(pricing) }) });
    assert.equal(row.usd, 0.0002);
  }
  const broken = memoryFs({ [override]: 'invalid json', [DEFAULT_PRICING_FILE]: JSON.stringify(pricing) });
  assert.equal(recordGeminiUsage(input, { home, now, fsImpl: broken }).usd, null);
  assert.equal(recordGeminiUsage(input, { home, now, fsImpl: memoryFs(), pricing: { ...pricing, validThrough: '2026-08-31' } }).usd, null);
});
test('batch, cache and explicit net search prices are charged without assuming free quota', () => {
  const row = recordGeminiUsage({ ...input, cachedTokens: 20, mode: 'batch', searchCalls: 2 }, { home, now, fsImpl: memoryFs(), pricing });
  assert.equal(row.usd, (80 + 2 + 100) / 1e6 * 0.5 + 0.02);
  const unknownSearch = { models: { known: { ...pricing.models.known, searchUsdPerCall: null } } };
  assert.equal(recordGeminiUsage({ ...input, searchCalls: 1 }, { home, now, fsImpl: memoryFs(), pricing: unknownSearch }).usd, null);
});
test('MCP hook records text-only results as unmeasured and ignores unrelated tools', () => {
  const rows = [];
  const recordImpl = (args) => { const row = recordGeminiUsage(args, { home, now, fsImpl: memoryFs(), pricing }); rows.push(row); return row; };
  const event = { tool_name: 'mcp__gemini-cli__ask-gemini', tool_input: { prompt: 'private text', model: 'known' }, tool_response: { content: [{ type: 'text', text: 'answer' }] } };
  // home/now pinning keeps the chat-log fallback hermetic: no scan of the real ~/.gemini.
  recordGeminiMcpEvent(event, { recordImpl, home, now });
  assert.equal(rows[0].source, 'mcp'); assert.equal(rows[0].usd, null); assert.equal(rows[0].estimated, true);
  assert.ok(!JSON.stringify(rows[0]).includes('private text'));
  recordGeminiMcpEvent({ ...event, tool_name: 'Bash' }, { recordImpl, home, now });
  assert.equal(rows.length, 1);
  assert.doesNotThrow(() => recordGeminiMcpEvent(event, { recordImpl: () => { throw new Error('disk full'); }, home, now }));
});
test('MCP structured metadata and failure responses each produce a row', () => {
  const rows = [];
  const recordImpl = (row) => rows.push(row);
  recordGeminiMcpEvent({ tool_name: 'mcp__gemini-cli__ask-gemini', tool_response: { structuredContent: { modelVersion: 'known', usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8 } } } }, { recordImpl, home, now });
  recordGeminiMcpEvent({ tool_name: 'mcp__gemini-cli__ask-gemini', hook_event_name: 'PostToolUseFailure' }, { recordImpl, home, now });
  assert.equal(rows[0].inTokens, 7); assert.equal(rows[0].outTokens, 8); assert.equal(rows[1].status, 'error'); assert.equal(rows[1].inTokens, null);
});
