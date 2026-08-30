import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateWaitStats, classifyStop, extractHumanTurns } from './interaction-loop.mjs';

const row = (content, extra = {}) => JSON.stringify({ type: 'user', timestamp: '2026-08-30T00:00:00Z', message: { role: 'user', content }, ...extra });

test('extractHumanTurns excludes tool_result rows', () => {
  assert.deepEqual(extractHumanTurns([row([{ type: 'tool_result', content: 'ok' }, { type: 'text', text: '進めて' }])]), []);
});

test('extractHumanTurns excludes task-notification rows', () => {
  assert.deepEqual(extractHumanTurns([row('<task-notification>done</task-notification>')]), []);
});

test('extractHumanTurns excludes Stop hook feedback rows', () => {
  assert.deepEqual(extractHumanTurns([row('Stop hook feedback: continue')]), []);
});

test('extractHumanTurns excludes system-reminder-only rows', () => {
  assert.deepEqual(extractHumanTurns([row('<system-reminder>internal\nnotice</system-reminder>')]), []);
});

test('extractHumanTurns keeps ordinary Japanese input', () => {
  const turns = extractHumanTurns([row('このまま進めてください', { sessionFile: 'abc.jsonl' })]);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'このまま進めてください');
  assert.equal(turns[0].sessionFile, 'abc.jsonl');
});

test('classifyStop prioritizes permission over completion', () => {
  assert.equal(classifyStop('完了しました。進めて良いですか？'), 'ASK_PERMISSION');
});

test('classifyStop recognizes empty notice', () => {
  assert.equal(classifyStop('No response requested'), 'EMPTY_NOTICE');
});

test('wait median uses the fixed sample correctly', () => {
  const result = calculateWaitStats([10, 20, 30, 40, 50]);
  assert.equal(result.medianSec, 30);
  assert.equal(result.p75Sec, 40);
});
