import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

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
