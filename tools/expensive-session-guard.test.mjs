import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'expensive-session-guard.mjs');
function fixture(model = 'claude-opus-5', usage = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-guard-'));
  const transcript = path.join(root, 'session.jsonl');
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, usage: { cache_read_input_tokens: usage } } })}\n`);
  return { root, transcript };
}
function run(root, input, env = {}) {
  return spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: root, ...env } });
}
function assistant(model, usage) {
  return JSON.stringify({ type: 'assistant', message: { role: 'assistant', model, usage: { cache_read_input_tokens: usage } } });
}
function aggregate(root, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(root, '.claude', 'session-guard', `${sessionId}.json`), 'utf8')).aggregate;
}

test('opus-4-7 warns', () => {
  const f = fixture('claude-opus-4-7');
  const result = run(f.root, { transcript_path: f.transcript, session_id: 'a' });
  assert.equal(result.status, 0); assert.match(result.stdout, /\/model opus/); assert.match(result.stdout, /claude-opus-4-7/);
});
test('opus-5 alone is silent', () => {
  const f = fixture();
  assert.equal(run(f.root, { transcript_path: f.transcript }).stdout, '');
});
test('missing transcript_path exits zero and is silent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-guard-'));
  const result = run(root, {}); assert.equal(result.status, 0); assert.equal(result.stdout, '');
});
test('over threshold proposes session split', () => {
  const f = fixture('claude-opus-5', 11);
  const result = run(f.root, { transcript_path: f.transcript }, { ORGIAST_SESSION_TOK_LIMIT: '10' });
  assert.match(result.stdout, /\/session-close/);
});
test('same warning is suppressed for 30 minutes', () => {
  const f = fixture('claude-opus-4-7'); const input = { transcript_path: f.transcript, session_id: 'same' };
  assert.match(run(f.root, input).stdout, /\/model opus/); assert.equal(run(f.root, input).stdout, '');
});

test('legacy warning state is preserved alongside aggregate', () => {
  const f = fixture('claude-opus-4-7'); const sessionId = 'legacy';
  const stateDir = path.join(f.root, '.claude', 'session-guard');
  const timestamp = new Date().toISOString();
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, `${sessionId}.json`), `${JSON.stringify({ model: timestamp })}\n`);
  const result = run(f.root, { transcript_path: f.transcript, session_id: sessionId });
  const state = JSON.parse(fs.readFileSync(path.join(stateDir, `${sessionId}.json`), 'utf8'));
  assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(state.model, timestamp);
  assert.deepEqual(state.aggregate, { offset: fs.statSync(f.transcript).size, turns: 1, cacheRead: 1, lastModel: 'claude-opus-4-7' });
});

test('second run adds only appended records', () => {
  const f = fixture('claude-opus-5', 3); const input = { transcript_path: f.transcript, session_id: 'append' };
  run(f.root, input);
  const first = aggregate(f.root, 'append');
  const addition = `${assistant('claude-opus-5', 5)}\n${assistant('claude-opus-5', 7)}\n`;
  fs.appendFileSync(f.transcript, addition);
  run(f.root, input);
  const second = aggregate(f.root, 'append');
  assert.deepEqual({ turns: second.turns, cacheRead: second.cacheRead }, { turns: 3, cacheRead: 15 });
  assert.equal(second.offset - first.offset, Buffer.byteLength(addition));
  assert.equal(second.offset, fs.statSync(f.transcript).size);
});

test('incomplete trailing line is counted once after completion', () => {
  const f = fixture('claude-opus-5', 2); const input = { transcript_path: f.transcript, session_id: 'partial' };
  run(f.root, input);
  const completeOffset = aggregate(f.root, 'partial').offset;
  const record = assistant('claude-opus-5', 9);
  const split = Math.floor(record.length / 2);
  fs.appendFileSync(f.transcript, record.slice(0, split));
  run(f.root, input);
  assert.deepEqual(aggregate(f.root, 'partial'), { offset: completeOffset, turns: 1, cacheRead: 2, lastModel: 'claude-opus-5' });
  fs.appendFileSync(f.transcript, `${record.slice(split)}\n`);
  run(f.root, input);
  assert.deepEqual(aggregate(f.root, 'partial'), { offset: fs.statSync(f.transcript).size, turns: 2, cacheRead: 11, lastModel: 'claude-opus-5' });
});

test('shrunk transcript resets and rebuilds aggregate', () => {
  const f = fixture('claude-opus-5', 4); const input = { transcript_path: f.transcript, session_id: 'shrunk' };
  fs.appendFileSync(f.transcript, `${assistant('claude-opus-5', 6)}\n`);
  run(f.root, input);
  fs.writeFileSync(f.transcript, `${assistant('claude-opus-4-7', 8)}\n`);
  run(f.root, input);
  assert.deepEqual(aggregate(f.root, 'shrunk'), { offset: fs.statSync(f.transcript).size, turns: 1, cacheRead: 8, lastModel: 'claude-opus-4-7' });
});
