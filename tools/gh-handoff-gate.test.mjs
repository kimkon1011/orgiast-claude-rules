import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { judge, formatReason } from './gh-handoff-gate.mjs';

const GATE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'gh-handoff-gate.mjs');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'gh-handoff-test-'));

function run(entries, { stopHookActive = false } = {}) {
  const tp = path.join(tmp, `t${Math.round(Math.random() * 1e6)}.jsonl`);
  writeFileSync(tp, entries.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  const r = spawnSync(process.execPath, [GATE], {
    input: JSON.stringify({ stop_hook_active: stopHookActive, transcript_path: tp }),
    encoding: 'utf8', timeout: 20000,
  });
  return { out: (r.stdout || '').trim(), status: r.status };
}

const userLine = (text) => ({ type: 'user', message: { content: text } });
const asstLine = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

// --- Unit tests for judge ---
test('judge unit test - block case', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします';
  const result = judge(text);
  assert.deepEqual(result, { triggered: true, missing: ['credential fill の試行結果'] });
});

test('judge unit test - pass with credential fill', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします\n確認済み: git credential fill → exit 1（credential helper 未設定）';
  const result = judge(text);
  assert.deepEqual(result, { triggered: true, missing: [] });
});

test('judge unit test - pass with escape valve', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします\n[GH-HANDOFF-OK]';
  const result = judge(text);
  assert.deepEqual(result, { triggered: false, missing: [] });
});

test('judge unit test - reports (no request)', () => {
  const text = 'PR を作成しました。gh auth login は不要でした';
  const result = judge(text);
  assert.deepEqual(result, { triggered: false, missing: [] });
});

test('judge unit test - request but no auth issue', () => {
  const text = 'マージをお願いします';
  const result = judge(text);
  assert.deepEqual(result, { triggered: false, missing: [] });
});

test('judge unit test - inside code block only', () => {
  const text = 'PR 作成をお願いします\n```\ngh auth status で未認証\n```';
  const result = judge(text);
  assert.deepEqual(result, { triggered: false, missing: [] });
});


// --- Integration tests for stdin/stdout ---
test('Integration: unauthenticated gh without credential fill → block', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします';
  const { out, status } = run([userLine('start'), asstLine(text)]);
  assert.ok(out.includes('"decision":"block"'), `stdout should block: ${out}`);
  assert.ok(out.includes('[GH-HANDOFF]'), `stdout should contain reason: ${out}`);
  assert.equal(status, 0);
});

test('Integration: unauthenticated gh with credential fill → pass', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします\n確認済み: git credential fill → exit 1';
  const { out, status } = run([userLine('start'), asstLine(text)]);
  assert.equal(out, '', 'should pass and output nothing');
  assert.equal(status, 0);
});

test('Integration: unauthenticated gh with escape valve → pass', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします\n[GH-HANDOFF-OK]';
  const { out, status } = run([userLine('start'), asstLine(text)]);
  assert.equal(out, '', 'should pass with escape valve and output nothing');
  assert.equal(status, 0);
});

test('Integration: report/completed action → pass', () => {
  const text = 'PR を作成しました。gh auth login は不要でした';
  const { out, status } = run([userLine('start'), asstLine(text)]);
  assert.equal(out, '', 'completed action report should pass and output nothing');
  assert.equal(status, 0);
});

test('Integration: request but no gh mention → pass', () => {
  const text = 'マージをお願いします';
  const { out, status } = run([userLine('start'), asstLine(text)]);
  assert.equal(out, '', 'no gh unauthenticated mention should pass and output nothing');
  assert.equal(status, 0);
});

test('Integration: stop_hook_active: true → pass', () => {
  const text = 'gh が未認証なので、PR の作成をお願いします';
  const { out, status } = run([userLine('start'), asstLine(text)], { stopHookActive: true });
  assert.equal(out, '', 'stop_hook_active: true should pass and output nothing');
  assert.equal(status, 0);
});
