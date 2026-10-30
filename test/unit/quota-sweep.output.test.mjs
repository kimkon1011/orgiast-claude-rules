import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseOutput, isTransientWindowReadError,
  normalizeLandedChecks, normalizeLandedContract,
} from '../../tools/quota-sweep.mjs';

// ── parseOutput ────────────────────────────────────────────────────────

test('parseOutput detects FINAL from structured JSON result', () => {
  const out = JSON.stringify({ result: 'FINAL\nall tests green', usage: { input_tokens: 10, output_tokens: 5 } });
  const parsed = parseOutput(out);
  assert.equal(parsed.final, true);
  assert.equal(parsed.input, 10);
  assert.equal(parsed.output, 5);
});

test('parseOutput detects ITERATING (non-FINAL)', () => {
  const out = JSON.stringify({ result: 'ITERATING: fixing import errors' });
  assert.equal(parseOutput(out).final, false);
});

test('parseOutput detects FINAL from JSONL agent_message', () => {
  const lines = [
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'FINAL\nAll criteria satisfied' } }),
  ];
  const parsed = parseOutput(lines.join('\n'));
  assert.equal(parsed.final, true);
  assert.equal(parsed.input, 7);
  assert.equal(parsed.output, 3);
});

test('parseOutput ignores non-agent_message items', () => {
  const lines = [
    JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: 'FINAL' } }),
  ];
  assert.equal(parseOutput(lines.join('\n')).final, false);
});

test('parseOutput handles malformed JSON gracefully', () => {
  const parsed = parseOutput('not json at all\nmore noise');
  assert.equal(parsed.final, false);
  assert.equal(parsed.input, 0);
  assert.equal(parsed.output, 0);
});

test('parseOutput aggregates tokens across multiple turn.completed lines', () => {
  const lines = [
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 50 } }),
    JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 30, output_tokens: 20 } }),
  ];
  const parsed = parseOutput(lines.join('\n'));
  assert.equal(parsed.final, false);
  assert.equal(parsed.input, 130);
  assert.equal(parsed.output, 70);
});

test('parseOutput returns empty result for empty input', () => {
  const parsed = parseOutput('');
  assert.equal(parsed.final, false);
  assert.equal(parsed.input, 0);
  assert.equal(parsed.output, 0);
  assert.equal(parsed.message, '');
});

// ── isTransientWindowReadError ─────────────────────────────────────────

test('isTransientWindowReadError classifies transient errors', () => {
  for (const reason of ['HTTP 429', 'HTTP 503', 'HTTP 408', 'HTTP 500', 'HTTP 502', 'network: TimeoutError', 'network: ConnectionRefused']) {
    assert.ok(isTransientWindowReadError(reason), `${reason} should be transient`);
  }
});

test('isTransientWindowReadError classifies non-transient errors', () => {
  for (const reason of ['HTTP 401', 'HTTP 403', 'HTTP 400', 'HTTP 404', 'accessToken 未設定', 'credentials: ENOENT', 'usage response の形式が未対応', '', undefined, null]) {
    assert.equal(isTransientWindowReadError(reason), false, `${reason} should NOT be transient`);
  }
});

// ── normalizeLandedChecks ─────────────────────────────────────────────

test('normalizeLandedChecks replaces git merge-base with commit-landed.mjs', () => {
  const input = '```\ngit merge-base --is-ancestor eee266e origin/main\n```';
  const output = normalizeLandedChecks(input);
  assert.ok(output.includes('node tools/commit-landed.mjs eee266e'));
  assert.equal(output.includes('git merge-base --is-ancestor'), false);
});

test('normalizeLandedChecks does not replace other git commands', () => {
  const input = 'git merge-base --is-ancestor abc origin/main-other';
  assert.equal(normalizeLandedChecks(input), input);
});

test('normalizeLandedChecks is idempotent', () => {
  const input = '`git merge-base --is-ancestor eee266e origin/main`';
  const once = normalizeLandedChecks(input);
  const twice = normalizeLandedChecks(once);
  assert.equal(once, twice);
});

test('normalizeLandedChecks replaces all occurrences', () => {
  const input = 'A: `git merge-base --is-ancestor aaa origin/main`\nB: `git merge-base --is-ancestor bbb origin/main`';
  const output = normalizeLandedChecks(input);
  assert.ok(output.includes('commit-landed.mjs aaa'));
  assert.ok(output.includes('commit-landed.mjs bbb'));
});

// ── normalizeLandedContract (file-level) ──────────────────────────────

const temp = t => {
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'quota-sweep-output-'));
  t.after(() => fs.rmSync(p, { recursive: true, force: true }));
  return p;
};

test('normalizeLandedContract normalizes .md files in-place', t => {
  const dir = temp(t);
  const file = path.join(dir, 'contract.md');
  fs.writeFileSync(file, 'Check: `git merge-base --is-ancestor abc123 origin/main`\n');
  normalizeLandedContract(file);
  const content = fs.readFileSync(file, 'utf8');
  assert.ok(content.includes('node tools/commit-landed.mjs abc123'));
  assert.equal(content.includes('git merge-base --is-ancestor'), false);
});

test('normalizeLandedContract does nothing if file does not exist', () => {
  normalizeLandedContract('/nonexistent/path/contract.md');
});

test('normalizeLandedContract does nothing to already-normalized files', t => {
  const dir = temp(t);
  const file = path.join(dir, 'clean.md');
  const content = 'Check: `node tools/commit-landed.mjs abc123`\n';
  fs.writeFileSync(file, content);
  normalizeLandedContract(file);
  assert.equal(fs.readFileSync(file, 'utf8'), content);
});