import assert from 'node:assert/strict';
import test from 'node:test';
import { judge, TARGET, HOOK_MATCHER } from './gmail-connector-url-gate.mjs';

const DRAFT_ID = 'r123';
const URL_BODY = 'Check this: https://meet.google.com/abc-defg-hij';

test('HOOK_MATCHER matches send_message', () => {
  const re = new RegExp(`^(?:${HOOK_MATCHER})$`);
  assert.ok(re.test('mcp__claude_ai_Gmail__send_message'), 'send_message');
  assert.ok(re.test('mcp__claude_ai_Gmail__create_draft'), 'create_draft');
  assert.ok(re.test('mcp__claude_ai_Gmail__update_draft'), 'update_draft');
  assert.ok(re.test('mcp__claude_ai_Gmail__reply'), 'reply');
  assert.ok(re.test('mcp__claude_ai_Gmail__forward'), 'forward');
  assert.ok(re.test('mcp__claude_ai_Gmail_1__send_message'), 'send_message with digit');
});

test('send_message with draftId + URL body passes', () => {
  const result = judge({
    tool_name: 'mcp__claude_ai_Gmail__send_message',
    tool_input: { draftId: DRAFT_ID, body: URL_BODY },
  });
  assert.equal(result.decision, 'pass');
});

test('send_message without draftId + URL body blocks', () => {
  const result = judge({
    tool_name: 'mcp__claude_ai_Gmail__send_message',
    tool_input: { body: URL_BODY },
  });
  assert.equal(result.decision, 'block');
});

test('create_draft with URL body blocks even if draftId-like in body', () => {
  const result = judge({
    tool_name: 'mcp__claude_ai_Gmail__create_draft',
    tool_input: { body: URL_BODY },
  });
  assert.equal(result.decision, 'block');
});

test('update_draft with URL body blocks', () => {
  const result = judge({
    tool_name: 'mcp__claude_ai_Gmail__update_draft',
    tool_input: { body: URL_BODY, draftId: DRAFT_ID },
  });
  assert.equal(result.decision, 'block');
});

test('reply with URL body blocks', () => {
  const result = judge({
    tool_name: 'mcp__claude_ai_Gmail__reply',
    tool_input: { body: URL_BODY },
  });
  assert.equal(result.decision, 'block');
});

test('forward with URL body blocks', () => {
  const result = judge({
    tool_name: 'mcp__claude_ai_Gmail__forward',
    tool_input: { body: URL_BODY },
  });
  assert.equal(result.decision, 'block');
});

test('send_message with draftId + no URL body still passes', () => {
  const result = judge({
    tool_name: 'mcp__claude_ai_Gmail__send_message',
    tool_input: { draftId: DRAFT_ID, body: 'No URL here' },
  });
  assert.equal(result.decision, 'pass');
});

test('send_message with empty draftId + URL body blocks', () => {
  const result = judge({
    tool_name: 'mcp__claude_ai_Gmail__send_message',
    tool_input: { draftId: '', body: URL_BODY },
  });
  assert.equal(result.decision, 'block');
});

test('send_message with URL in subject blocks (no draftId)', () => {
  const result = judge({
    tool_name: 'mcp__claude_ai_Gmail__send_message',
    tool_input: { subject: 'https://example.com' },
  });
  assert.equal(result.decision, 'block');
});

test('non-Gmail tool passes through', () => {
  const result = judge({
    tool_name: 'mcp__something_else',
    tool_input: { body: URL_BODY },
  });
  assert.equal(result.decision, 'pass');
});
