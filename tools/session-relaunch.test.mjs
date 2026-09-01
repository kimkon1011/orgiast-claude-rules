import assert from 'node:assert/strict';
import test from 'node:test';
import { ARM_TTL_MS, armState, buildContext, normalizeState, shouldInject } from './session-relaunch.mjs';

const NOW = Date.parse('2026-08-28T12:00:00.000Z');
const armedState = (overrides = {}) => ({
  enabled: true,
  armed: { at: new Date(NOW - 60_000).toISOString(), sessionId: 'closed-me', cwd: 'D:\\work', ...overrides },
});

test('normalizeState は壊れた入力を安全側へ倒す', () => {
  assert.deepEqual(normalizeState(null), { enabled: true, armed: null });
  assert.deepEqual(normalizeState({ armed: { at: 'not-a-date' } }), { enabled: true, armed: null });
  assert.equal(normalizeState({ enabled: false }).enabled, false);
  const ok = normalizeState({ armed: { at: '2026-08-28T00:00:00.000Z', sessionId: 7, cwd: null } });
  assert.deepEqual(ok.armed, { at: '2026-08-28T00:00:00.000Z', sessionId: '7', cwd: '' });
});

test('armState は無効時に武装せず、元の state を書き換えない', () => {
  const off = { enabled: false, armed: null };
  assert.equal(armState(off, { sessionId: 'a', cwd: 'c', now: NOW }).armed, null);
  const on = { enabled: true, armed: null };
  const next = armState(on, { sessionId: 'a', cwd: 'c', now: NOW });
  assert.equal(on.armed, null);
  assert.equal(next.armed.sessionId, 'a');
  assert.equal(next.armed.at, new Date(NOW).toISOString());
});

test('shouldInject は新しいセッションの startup/clear/fork でだけ true', () => {
  for (const source of ['startup', 'clear', 'fork']) {
    assert.equal(shouldInject(armedState(), { session_id: 'new', source }, NOW), true, source);
  }
  // resume と compact は同じ作業の続きなので注入しない。
  for (const source of ['resume', 'compact', undefined]) {
    assert.equal(shouldInject(armedState(), { session_id: 'new', source }, NOW), false, String(source));
  }
});

test('shouldInject は自分自身・未武装・無効・期限切れを弾く', () => {
  assert.equal(shouldInject(armedState(), { session_id: 'closed-me', source: 'clear' }, NOW), false);
  assert.equal(shouldInject(armedState(), { session_id: '', source: 'clear' }, NOW), false);
  assert.equal(shouldInject({ enabled: true, armed: null }, { session_id: 'new', source: 'clear' }, NOW), false);
  assert.equal(shouldInject({ ...armedState(), enabled: false }, { session_id: 'new', source: 'clear' }, NOW), false);
  const stale = armedState({ at: new Date(NOW - ARM_TTL_MS - 1000).toISOString() });
  assert.equal(shouldInject(stale, { session_id: 'new', source: 'startup' }, NOW), false);
  // 時計が巻き戻った状態の予約も信用しない。
  const future = armedState({ at: new Date(NOW + 60_000).toISOString() });
  assert.equal(shouldInject(future, { session_id: 'new', source: 'startup' }, NOW), false);
});

test('buildContext は session-start の実行指示と停止方法を必ず含む', () => {
  const text = buildContext(armedState().armed);
  assert.match(text, /session-start/);
  assert.match(text, /--off/);
  assert.match(text, /D:\\work/);
  assert.doesNotMatch(text, /Invalid Date/);
});
