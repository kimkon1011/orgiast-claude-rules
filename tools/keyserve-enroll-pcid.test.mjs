import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { keyserveEnrollPcId } from './keyserve-auth.mjs';

function enrollToken(pcId) {
  return `ORG1.${Buffer.from(pcId).toString('base64url')}.9999999999.${'a'.repeat(43)}`;
}

test('extracts pcId from an enroll token', () => {
  assert.equal(keyserveEnrollPcId(enrollToken('NEWPC')), 'NEWPC');
});

test('returns empty string for malformed enroll tokens without throwing', () => {
  const malformed = [
    '',
    'ORG1',
    'ORG1.a.b',
    `ORG1.!!!.999.${'a'.repeat(43)}`,
    enrollToken('bad name!'),
  ];
  for (const token of malformed) {
    assert.doesNotThrow(() => keyserveEnrollPcId(token));
    assert.equal(keyserveEnrollPcId(token), '');
  }
});

test('onboarding sync prefers the pcId from an enroll token', () => {
  const source = fs.readFileSync(new URL('./onboarding-sync.mjs', import.meta.url), 'utf8');
  assert.match(source, /enrollToken \? keyserveEnrollPcId\(/);
});
