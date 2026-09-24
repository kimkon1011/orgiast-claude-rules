import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContext, FOOTER, main } from './fleet-inbox-context.mjs';

test('zero unread messages use zero context', () => assert.equal(buildContext([]), ''));
test('many messages stay within 1500 characters and retain reply/ack footer', () => {
  const entries = Array.from({ length: 100 }, (_, i) => ({ id: `mail-${i}`, from: 'PC', kind: 'note', why: '確認', body: 'あ'.repeat(20000) }));
  const result = buildContext(entries);
  assert.ok(result.length <= 1500); assert.ok(result.endsWith(FOOTER));
  assert.match(result, /from=PC \/ kind=note \/ why=確認 \/ id=mail-0/);
});
test('context redacts secrets before truncation', () => {
  const result = buildContext([{ id: 'mail-1', from: 'PC', kind: 'note', why: 'token=secret-reason', body: 'x'.repeat(290) + ' api_key=secret-value https://discord.com/api/webhooks/123/secret' }]);
  assert.doesNotMatch(result, /secret-reason|secret-value|webhooks\/123/);
});
test('empty, malformed input and missing inbox produce no hook output', async () => {
  for (const input of ['', '{', '{}', '{"prompt":"hello"}']) {
    const outputs = [];
    await main({ home: '/missing/fleet-inbox-test', readStdin: async () => input, stdout: t => outputs.push(t) });
    assert.deepEqual(outputs, []);
  }
});
