import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findUnansweredRequest } from './unanswered-request.mjs';

const file = '/projects/session-1.jsonl';
const lines = entries => entries.map(entry => JSON.stringify(entry)).join('\n');
const user = { type: 'user', timestamp: '2026-10-15T00:00:00Z', cwd: '/repo', message: { role: 'user', content: '資料を作ってください' } };
const apiError = { type: 'assistant', timestamp: '2026-10-15T00:01:00Z', isApiErrorMessage: true, error: 'rate_limit', apiError: 'model_requires_usage_credits', apiErrorStatus: 429, message: { role: 'assistant', model: '<synthetic>', content: "You've reached your limit." } };

test('合成APIエラーで終わる本線は未返答と判定する', () => {
  assert.deepEqual(findUnansweredRequest(file, { readFile: () => lines([user, apiError]) }), {
    sessionId: 'session-1', cwd: '/repo', transcriptPath: file, requestText: '資料を作ってください',
    errorAt: '2026-10-15T00:01:00Z', error: 'rate_limit', apiError: 'model_requires_usage_credits', apiErrorStatus: 429,
  });
});

test('APIエラー後に通常assistant返答があれば未返答ではない', () => {
  const reply = { type: 'assistant', timestamp: '2026-10-15T00:02:00Z', message: { role: 'assistant', model: 'claude', content: '対応しました' } };
  assert.equal(findUnansweredRequest(file, { readFile: () => lines([user, apiError, reply]) }), null);
});

test('サイドチェーンの通常assistant返答は無視する', () => {
  const side = { type: 'assistant', isSidechain: true, timestamp: '2026-10-15T00:02:00Z', message: { role: 'assistant', model: 'claude', content: 'subagent返答' } };
  assert.ok(findUnansweredRequest(file, { readFile: () => lines([user, side, apiError]) }));
});

test('末尾が tool_use のみ・mtime 2 時間前 → silent-stop で検出', () => {
  const now = Date.parse('2026-10-15T02:00:00Z');
  const toolUse = { type: 'assistant', timestamp: '2026-10-15T00:00:30Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'share_file' }] } };
  const mtimeMs = Date.parse('2026-10-15T00:00:30Z');
  const found = findUnansweredRequest(file, { readFile: () => lines([user, toolUse]), mtimeMs, now });
  assert.deepEqual(found, {
    sessionId: 'session-1', cwd: '/repo', transcriptPath: file, requestText: '資料を作ってください',
    errorAt: '2026-10-15T00:00:30Z', error: 'silent_stop', apiError: '', apiErrorStatus: '', kind: 'silent-stop',
  });
});

test('末尾が tool_use のみ・mtime 10 分前 → 検出しない', () => {
  const now = Date.parse('2026-10-15T00:10:00Z');
  const toolUse = { type: 'assistant', timestamp: '2026-10-15T00:00:30Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'share_file' }] } };
  const mtimeMs = Date.parse('2026-10-15T00:00:30Z');
  assert.equal(findUnansweredRequest(file, { readFile: () => lines([user, toolUse]), mtimeMs, now }), null);
});

test('tool_use の後に tool_result と assistant text がある → 検出しない', () => {
  const now = Date.parse('2026-10-15T02:00:00Z');
  const toolUse = { type: 'assistant', timestamp: '2026-10-15T00:00:30Z', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'share_file' }] } };
  const toolResult = { type: 'user', timestamp: '2026-10-15T00:00:40Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'ok' }] } };
  const reply = { type: 'assistant', timestamp: '2026-10-15T00:01:00Z', message: { role: 'assistant', content: '資料を共有しました' } };
  const mtimeMs = Date.parse('2026-10-15T00:01:00Z');
  assert.equal(findUnansweredRequest(file, { readFile: () => lines([user, toolUse, toolResult, reply]), mtimeMs, now }), null);
});

test('末尾が user 依頼で応答なし・mtime 2 時間前 → 検出', () => {
  const now = Date.parse('2026-10-15T02:00:00Z');
  const mtimeMs = Date.parse('2026-10-15T00:00:00Z');
  const found = findUnansweredRequest(file, { readFile: () => lines([user]), mtimeMs, now });
  assert.deepEqual(found, {
    sessionId: 'session-1', cwd: '/repo', transcriptPath: file, requestText: '資料を作ってください',
    errorAt: '2026-10-15T00:00:00Z', error: 'silent_stop', apiError: '', apiErrorStatus: '', kind: 'silent-stop',
  });
});

test('2MB 級の実 transcript で user 依頼が読取窓(512KB)の外でも検出される（全文フォールバック）', async t => {
  // 実データ 4832b083（2.1MB）では最後の user 依頼が byte ~932KB にあり、
  // 既定の readTail(512KB) では窓の外 → userIndex<0 で null になっていた。
  // 全文フォールバックで検出できることを確認する。
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ap-unanswered-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const big = path.join(dir, 'session-big.jsonl');
  // 先頭に user 依頼、続いて 512KB を超える tool_result 洪水、末尾に tool_use（未完了）
  const padding = Array.from({ length: 700 }, (_, i) => JSON.stringify({
    type: 'user', timestamp: '2026-10-15T00:00:10Z', message: {
      role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'x'.repeat(900) }],
    },
  })).join('\n');
  const toolUse = JSON.stringify({
    type: 'assistant', timestamp: '2026-10-15T00:00:30Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tool_1', name: 'share_file' }] },
  });
  const body = [JSON.stringify(user), padding, toolUse].join('\n');
  assert.ok(Buffer.byteLength(body, 'utf8') > 512 * 1024, 'fixture must exceed the 512KB tail window');
  await fs.promises.writeFile(big, body);
  const now = Date.parse('2026-10-15T02:00:00Z');
  const mtimeMs = Date.parse('2026-10-15T00:00:30Z');
  const found = findUnansweredRequest(big, { mtimeMs, now }); // 既定 readTail + 全文フォールバック
  assert.deepEqual(found, {
    sessionId: 'session-big', cwd: '/repo', transcriptPath: big, requestText: '資料を作ってください',
    errorAt: '2026-10-15T00:00:30Z', error: 'silent_stop', apiError: '', apiErrorStatus: '', kind: 'silent-stop',
  });
});

