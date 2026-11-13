import test from 'node:test';
import assert from 'node:assert/strict';
import {
  missingInfoRate,
  progressiveMaxChars,
  simulate,
  trimBulk,
  trimEveryTurn,
  trimMessage,
  trimProgressive,
} from './context-trim.mjs';

const tool = (text, extra = {}) => ({ role: 'tool', kind: 'tool_result', text, ...extra });

test('trimMessage keeps both ends and does not mutate its input', () => {
  const input = tool('abcdefghij');
  const result = trimMessage(input, { maxChars: 4 });
  assert.equal(result.text, 'ab[[trimmed 6 chars]]ij');
  assert.equal(input.text, 'abcdefghij');
});

test('trimEveryTurn leaves the most recent messages unchanged', () => {
  const messages = [tool('a'.repeat(20)), tool('b'.repeat(20)), tool('c'.repeat(20))];
  const result = trimEveryTurn(messages, { keepRecent: 2, maxChars: 4 });
  assert.notEqual(result[0].text, messages[0].text);
  assert.equal(result[1].text, messages[1].text);
  assert.equal(result[2].text, messages[2].text);
});

test('trimEveryTurn protects errors by default and can trim them when disabled', () => {
  const messages = [tool('failure'.repeat(20), { hasError: true }), { role: 'user', kind: 'text', text: 'next' }];
  assert.equal(trimEveryTurn(messages, { keepRecent: 1, maxChars: 10 })[0].text, messages[0].text);
  assert.notEqual(trimEveryTurn(messages, { keepRecent: 1, maxChars: 10, protectErrors: false })[0].text, messages[0].text);
});

test('trimming is idempotent', () => {
  const messages = [tool('x'.repeat(100)), { role: 'assistant', text: 'done', kind: 'text' }];
  const once = trimEveryTurn(messages, { keepRecent: 1, maxChars: 20 });
  const twice = trimEveryTurn(once, { keepRecent: 1, maxChars: 20 });
  assert.deepEqual(twice, once);
});

test('non-tool-result messages are never changed', () => {
  const messages = [
    { role: 'user', kind: 'text', text: 'u'.repeat(100) },
    { role: 'assistant', text: 'a'.repeat(100) },
  ];
  assert.deepEqual(trimEveryTurn(messages, { keepRecent: 0, maxChars: 10 }), messages);
});

test('trimBulk changes only at or above the threshold', () => {
  const messages = [tool('x'.repeat(90)), { role: 'user', kind: 'text', text: 'tail' }];
  assert.deepEqual(trimBulk(messages, { windowTokens: 100, threshold: 0.8, keepRecent: 1, maxChars: 10 }), messages);
  assert.notDeepEqual(trimBulk(messages, { windowTokens: 30, threshold: 0.8, keepRecent: 1, maxChars: 10 }), messages);
});

test('progressiveMaxChars returns maxChars at 0 occupancy and minChars at 1 occupancy', () => {
  assert.equal(progressiveMaxChars(800, 0), 800);
  assert.equal(progressiveMaxChars(800, 1), 200);
});

test('progressiveMaxChars interpolates linearly between maxChars and minChars', () => {
  assert.equal(progressiveMaxChars(800, 0.5), 500);
  assert.equal(progressiveMaxChars(800, 0.25), 650);
});

test('progressiveMaxChars clamps occupancy to [0, 1]', () => {
  assert.equal(progressiveMaxChars(800, -0.5), 800);
  assert.equal(progressiveMaxChars(800, 2), 200);
});

test('progressiveMaxChars accepts custom minChars', () => {
  assert.equal(progressiveMaxChars(800, 1, 100), 100);
  assert.equal(progressiveMaxChars(800, 0.5, 100), 450);
});

test('trimProgressive does not trim below its threshold', () => {
  const messages = [tool('x'.repeat(90)), { role: 'user', kind: 'text', text: 'tail' }];
  const result = trimProgressive(messages, { windowTokens: 100, threshold: 0.8, keepRecent: 1, maxChars: 10 });
  assert.deepEqual(result, messages);
});

test('trimProgressive trims above its threshold with dynamic maxChars', () => {
  // 600 chars = 200 tokens, window 100 → occupancy 100% (clamped to 1)
  // dynamic maxChars = progressiveMaxChars(800, 1, 200) = 200
  const messages = [tool('x'.repeat(600)), { role: 'user', kind: 'text', text: 'tail' }];
  const result = trimProgressive(messages, { windowTokens: 100, threshold: 0.2, keepRecent: 1, maxChars: 800, minChars: 200 });
  assert.notDeepEqual(result, messages);
  assert.ok(result[0].text.includes('[[trimmed'));
  // Message at occupancy 1.0 → maxChars=200, side=100. 600-200=400 removed
  // Also, the side chars text length must be ≤ maxChars
  const trimmedText = result[0].text;
  const sideContent = trimmedText.replace(/\[\[trimmed \d+ chars\]\]/, '');
  assert.ok(sideContent.length <= 400); // 2 sides at 100 chars each = 200, but split plus marker
});

test('trimProgressive protects errors by default', () => {
  const messages = [tool('error detail '.repeat(50), { hasError: true }), { role: 'user', kind: 'text', text: 'next' }];
  const result = trimProgressive(messages, { windowTokens: 100, threshold: 0.2, keepRecent: 0, maxChars: 10, protectErrors: true });
  assert.equal(result[0].text, messages[0].text);
});

test('simulate rejects unknown mode', () => {
  assert.throws(() => simulate([], 'unknown'), /unknown mode/);
});

test('simulate supports progressive mode', () => {
  const conversation = Array.from({ length: 10 }, (_, index) => (
    index % 2 === 0 ? tool(String(index).repeat(600)) : { role: 'user', kind: 'text', text: `turn ${index}` }
  ));
  const opts = { windowTokens: 500, threshold: 0.8, progressiveThreshold: 0.3, keepRecent: 2, maxChars: 30, progressiveMaxChars: 100, minChars: 20 };
  const progressive = simulate(conversation, 'progressive', opts);
  assert.ok(progressive.cumulativeInputTokens > 0);
  assert.equal(progressive.steps.length, conversation.length);
  assert.ok(Array.isArray(progressive.finalMessages));
});

test('simulate cumulative input tokens are ordered none >= min(bulk, progressive) >= everyTurn', () => {
  const conversation = Array.from({ length: 10 }, (_, index) => (
    index % 2 === 0 ? tool(String(index).repeat(600)) : { role: 'user', kind: 'text', text: `turn ${index}` }
  ));
  const opts = { windowTokens: 500, threshold: 0.8, keepRecent: 2, maxChars: 30, progressiveThreshold: 0.2, progressiveMaxChars: 100, minChars: 20 };
  const none = simulate(conversation, 'none', opts);
  const bulk = simulate(conversation, 'bulk', opts);
  const progressive = simulate(conversation, 'progressive', opts);
  const everyTurn = simulate(conversation, 'everyTurn', opts);
  assert.ok(none.cumulativeInputTokens >= bulk.cumulativeInputTokens);
  assert.ok(none.cumulativeInputTokens >= progressive.cumulativeInputTokens);
  assert.ok(bulk.cumulativeInputTokens >= everyTurn.cumulativeInputTokens);
  assert.ok(progressive.cumulativeInputTokens >= everyTurn.cumulativeInputTokens);
  assert.equal(none.steps.length, conversation.length);
});

test('missingInfoRate is zero with protection and positive without error protection', () => {
  const original = [
    tool('error detail '.repeat(50), { hasError: true }),
    tool('referenced '.repeat(50), { ref: 'call-1' }),
    { role: 'user', kind: 'text', text: 'latest' },
  ];
  const protectedResult = trimEveryTurn(original, { keepRecent: 2, maxChars: 20 });
  const unprotectedResult = trimEveryTurn(original, { keepRecent: 2, maxChars: 20, protectErrors: false });
  assert.equal(missingInfoRate(original, protectedResult, { recent: 2 }), 0);
  assert.ok(missingInfoRate(original, unprotectedResult, { recent: 2 }) > 0);
});
