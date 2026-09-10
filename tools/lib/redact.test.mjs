import assert from 'node:assert/strict';
import test from 'node:test';
import { redactAll } from './redact.mjs';

test('redactAll masks supported credentials and long opaque values', () => {
  const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nvery-secret-material\n-----END RSA PRIVATE KEY-----';
  const input = `sk-${'a'.repeat(20)} ghp_${'b'.repeat(20)} github_pat_${'c'.repeat(20)} xoxb-${'d'.repeat(20)} Bearer abc.def password=hunter2 AIza${'e'.repeat(35)} ${'f'.repeat(40)} ${privateKey}`;
  const output = redactAll(input);
  for (const secret of ['a'.repeat(20), 'b'.repeat(20), 'c'.repeat(20), 'd'.repeat(20), 'abc.def', 'hunter2', 'e'.repeat(35), 'f'.repeat(40), 'very-secret-material']) assert.equal(output.includes(secret), false);
  assert.match(output, /\[REDACTED/);
});
