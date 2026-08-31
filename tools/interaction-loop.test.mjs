import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateWaitStats, classifyStop, diffMetrics, extractHumanTurns, retainMetricHistory, shouldPublish } from './interaction-loop.mjs';

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
  const result = calculateWaitStats([10, 20, 30, 40]);
  assert.equal(result.medianSec, 25);
  assert.equal(result.p75Sec, 30);
});

const metrics = (turnsPerDay = 100, total = 20, avoidable = 10, nudgeCount = 5, attendedMinutes = 30) => ({
  turnsPerDay, stops: { total, avoidable }, nudgeCount, wait: { attendedMinutes },
});

test('diffMetrics calculates a turnsPerDay decrease', () => {
  assert.equal(diffMetrics(metrics(100), metrics(80)).turnsPerDay.change, -20);
});

test('shouldPublish is false when all metrics stay within five percent', () => {
  assert.equal(shouldPublish(diffMetrics(metrics(100, 100, 100, 100, 100), metrics(105, 95, 104, 96, 101))), false);
});

test('shouldPublish is true when one metric exceeds five percent', () => {
  assert.equal(shouldPublish(diffMetrics(metrics(100, 100, 100, 100, 100), metrics(106, 100, 100, 100, 100))), true);
});

test('retainMetricHistory keeps only the newest thirty entries', () => {
  const history = Array.from({ length: 30 }, (_, index) => ({ generatedAt: String(index) }));
  const retained = retainMetricHistory(history, { generatedAt: '30' });
  assert.equal(retained.length, 30);
  assert.equal(retained[0].generatedAt, '1');
  assert.equal(retained.at(-1).generatedAt, '30');
});
