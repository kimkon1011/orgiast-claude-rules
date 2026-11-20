import test from 'node:test';
import assert from 'node:assert/strict';
import { sameFleetAddress } from './fleet-mail.mjs';

test('numeric fleet labels tolerate Sheets number coercion without matching a different seat', () => {
  assert.equal(sameFleetAddress(18, '018'), true);
  assert.equal(sameFleetAddress('18', '018'), true);
  assert.equal(sameFleetAddress('18', '019'), false);
});
