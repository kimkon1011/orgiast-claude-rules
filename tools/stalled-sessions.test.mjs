import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTranscript, rankSessions } from './stalled-sessions.mjs';

const nowMs = Date.parse('2026-09-20T12:00:00Z');
const event = (type, content) => JSON.stringify({ type, message: { role: type, content }, timestamp: '2026-09-19T00:00:00Z' });
const analyze = (lines, id, ageMs = 4 * 86_400_000) => analyzeTranscript({ raw: lines.join('\n'), sessionId: id, projectDir: 'project-a', mtimeMs: nowMs - ageMs, nowMs, nextSession: '' });

test('STOP-OK は残作業語があっても除外する', () => {
  assert.equal(analyze([event('user', '調査して'), event('assistant', '残りはありません。[STOP-OK]')], '11111111-1111-4111-8111-111111111111'), null);
});

test('session-close 済みは除外する', () => {
  assert.equal(analyze([event('user', '実装して'), event('assistant', '次にテストします'), event('assistant', '/session-close を実行してセッションをクローズしました')], '22222222-2222-4222-8222-222222222222'), null);
});

test('進行中の user 発話は残作業宣言として検出しない', () => {
  assert.equal(analyze([event('assistant', '次にテストします'), event('user', 'そのまま進めて')], '33333333-3333-4333-8333-333333333333', 60_000), null);
});

test('assistant の残作業宣言を最優先で検出する', () => {
  const item = analyze([event('user', '正式名を調べて'), event('assistant', '調査途中です。続きは正式名の確認です')], '44444444-4444-4444-8444-444444444444');
  assert.equal(item.reason, 'assistant末尾に残作業宣言');
  assert.equal(rankSessions([item])[0].sessionId, item.sessionId);
});
