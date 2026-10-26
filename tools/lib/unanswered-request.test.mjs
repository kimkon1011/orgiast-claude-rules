import assert from 'node:assert/strict';
import test from 'node:test';
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

