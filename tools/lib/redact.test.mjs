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

test('redactAll preserves Google file URLs but masks opaque values outside URLs', () => {
  const urls = [
    'https://drive.google.com/drive/folders/1hAvGAG1GuzqEIH5fyAtZ65f1wnwJBnke',
    `https://docs.google.com/document/d/${'a'.repeat(44)}/edit`,
    `https://docs.google.com/spreadsheets/d/${'b'.repeat(44)}/edit#gid=0`,
  ];
  const output = redactAll(`${urls.join(' ')} ${'c'.repeat(40)}`);
  for (const url of urls) assert.equal(output.includes(url), true);
  assert.equal(output.includes('c'.repeat(40)), false);
});

test('redactAll still masks named secrets inside URLs', () => {
  assert.equal(redactAll('https://x/?token=abc'), 'https://x/?token=[REDACTED]');
});
