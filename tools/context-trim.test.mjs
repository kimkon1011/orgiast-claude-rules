import test from 'node:test';
import assert from 'node:assert/strict';
import {
  missingInfoRate,
  simulate,
  trimBulk,
  trimEveryTurn,
  trimMessage,
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

test('simulate cumulative input tokens are ordered none >= bulk >= everyTurn', () => {
  const conversation = Array.from({ length: 10 }, (_, index) => (
    index % 2 === 0 ? tool(String(index).repeat(600)) : { role: 'user', kind: 'text', text: `turn ${index}` }
  ));
  const opts = { windowTokens: 500, threshold: 0.8, keepRecent: 2, maxChars: 30 };
  const none = simulate(conversation, 'none', opts);
  const bulk = simulate(conversation, 'bulk', opts);
  const everyTurn = simulate(conversation, 'everyTurn', opts);
  assert.ok(none.cumulativeInputTokens >= bulk.cumulativeInputTokens);
  assert.ok(bulk.cumulativeInputTokens >= everyTurn.cumulativeInputTokens);
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
