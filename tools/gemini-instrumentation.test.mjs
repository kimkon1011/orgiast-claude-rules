import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { findRecentGeminiChatUsage, recordGeminiMcpEvent } from './gemini-mcp-usage-hook.mjs';

// CLI integration: fake every HTTP request in child processes; use only temporary files.
function fixture(t, body) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-cli-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude'); fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'gemini-pricing.json'), JSON.stringify({ models: { 'gemini-3.7-flash': { inputUsdPerMillion: 0.75, outputUsdPerMillion: 3.75, batchMultiplier: 0.5 } } }));
  const preload = path.join(home, 'fetch.mjs');
  fs.writeFileSync(preload, `globalThis.fetch = async () => new Response(JSON.stringify(${JSON.stringify(body)}), { status: 200 });\n`);
  const env = { ...process.env, ORGIAST_HOME: home, USERPROFILE: home, ORGIAST_LOCK_HOME: home, GEMINI_API_KEY: 'test-only', ORGIAST_BATCH_DEADLINE: '23:59' };
  const run = (tool, args) => spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, path.join(import.meta.dirname, tool), ...args], { env, encoding: 'utf8', timeout: 15000 });
  const rows = () => fs.readFileSync(path.join(dir, 'executor-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  return { dir, run, rows };
}
test('llm-ask Gemini compatible response is recorded once with USD', (t) => {
  const f = fixture(t, { choices: [{ message: { content: 'answer' } }], usage: { prompt_tokens: 12, completion_tokens: 34 } });
  const result = f.run('llm-ask.mjs', ['--provider', 'gemini', '--no-fallback', 'question']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /answer/);
  const rows = f.rows(); assert.equal(rows.length, 1);
  assert.equal(rows[0].in, 12); assert.equal(rows[0].out, 34); assert.equal(typeof rows[0].usd, 'number');
});
test('llm-ask missing usage is null, never a zero-cost success', (t) => {
  const f = fixture(t, { choices: [{ message: { content: 'answer' } }] });
  const result = f.run('llm-ask.mjs', ['--provider', 'gemini', '--no-fallback', 'question']);
  assert.equal(result.status, 0, result.stderr);
  const [row] = f.rows(); assert.equal(row.in, null); assert.equal(row.out, null); assert.equal(row.usd, null); assert.equal(row.estimated, true);
});
test('native Gemini batch records usageMetadata once with batch rate and thinking', (t) => {
  const f = fixture(t, { name: 'batches/test', state: 'JOB_STATE_SUCCEEDED', output: { inlinedResponses: { inlinedResponses: [{ response: { candidates: [{ content: { parts: [{ text: 'answer' }] } }], usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 30, thoughtsTokenCount: 4 } } }] } } });
  const queue = path.join(f.dir, 'batch-queue'); fs.mkdirSync(queue);
  fs.writeFileSync(path.join(queue, 'pending.jsonl'), JSON.stringify({ id: 'test', provider: 'gemini', model: 'gemini-3.7-flash', prompt: 'question' }) + '\n');
  const result = f.run('batch-run.mjs', ['--force']);
  assert.equal(result.status, 0, result.stderr);
  const rows = f.rows(); assert.equal(rows.length, 1);
  assert.equal(rows[0].in, 12); assert.equal(rows[0].out, 34); assert.equal(rows[0].mode, 'batch');
  assert.equal(rows[0].usd, (12 * 0.75 + 34 * 3.75) / 1e6 * 0.5);
});

function chatFixture(t, rows, { mtime } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-chat-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const chats = path.join(home, '.gemini', 'tmp', 'claude-md', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const file = path.join(chats, 'session-x.jsonl');
  fs.writeFileSync(file, rows.map(JSON.stringify).join('\n') + '\n');
  if (mtime) fs.utimesSync(file, mtime, mtime);
  return home;
}

test('recent Gemini chat usage supplies model and real token counts', (t) => {
  const now = new Date('2026-09-19T00:02:00.000Z');
  const home = chatFixture(t, [{ type: 'gemini', timestamp: '2026-09-19T00:01:30.000Z', model: 'gemini-3.5-flash', content: 'answer', tokens: { input: 10566, output: 1, cached: 4, thoughts: 221, tool: 0, total: 10788 } }], { mtime: now });
  assert.deepEqual(findRecentGeminiChatUsage({ home, now }), { model: 'gemini-3.5-flash', inTokens: 10566, outTokens: 222, cachedTokens: 4 });
});

test('Gemini chat files with old mtime are ignored', (t) => {
  const now = new Date('2026-09-19T00:10:00.000Z');
  const home = chatFixture(t, [{ type: 'gemini', timestamp: '2026-09-19T00:09:30.000Z', tokens: { input: 1, output: 2, cached: 0, thoughts: 3 } }], { mtime: new Date('2026-09-19T00:00:00.000Z') });
  assert.equal(findRecentGeminiChatUsage({ home, now }), null);
});

test('MCP response content match wins over a newer Gemini chat candidate', (t) => {
  const now = new Date('2026-09-19T00:02:00.000Z');
  const home = chatFixture(t, [
    { type: 'gemini', timestamp: '2026-09-19T00:01:30.000Z', model: 'matched-model', content: 'wanted answer', tokens: { input: 10, output: 20, cached: 0, thoughts: 3 } },
    { type: 'gemini', timestamp: '2026-09-19T00:01:50.000Z', model: 'newest-model', content: 'different answer', tokens: { input: 40, output: 50, cached: 0, thoughts: 6 } },
  ], { mtime: now });
  let recorded;
  recordGeminiMcpEvent({ tool_name: 'mcp__gemini-cli__ask-gemini', tool_response: { content: [{ type: 'text', text: 'prefix wanted answer suffix' }] } }, { home, now, recordImpl: (row) => { recorded = row; return row; } });
  assert.equal(recorded.model, 'matched-model');
  assert.equal(recorded.inTokens, 10);
  assert.equal(recorded.outTokens, 23);
});

test('native MCP usageMetadata bypasses Gemini chat fallback', () => {
  let recorded;
  const fsImpl = { readdirSync() { throw new Error('fallback must not run'); } };
  recordGeminiMcpEvent({ tool_name: 'mcp__gemini-cli__geminiChat', tool_response: { modelVersion: 'native-model', usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 8, thoughtsTokenCount: 2 } } }, { fsImpl, recordImpl: (row) => { recorded = row; return row; } });
  assert.equal(recorded.model, 'native-model');
  assert.equal(recorded.inTokens, 7);
  assert.equal(recorded.outTokens, 10);
});

test('Gemini chat rows without tokens are not candidates', (t) => {
  const now = new Date('2026-09-19T00:02:00.000Z');
  const home = chatFixture(t, [{ type: 'gemini', timestamp: '2026-09-19T00:01:30.000Z', model: 'missing', content: 'answer' }], { mtime: now });
  assert.equal(findRecentGeminiChatUsage({ home, now }), null);
});
