import assert from 'node:assert/strict';
import test from 'node:test';
import { upsertEnvValue } from './env-kv.mjs';

test('upsertEnvValue updates or appends one env value without disturbing other text', () => {
  assert.equal(upsertEnvValue('', 'KEY', 'value'), 'KEY=value');
  assert.equal(upsertEnvValue('KEY=old\n', 'KEY', ''), 'KEY=\n');
  assert.equal(upsertEnvValue('OTHER=keep\n', 'KEY', 'value'), 'OTHER=keep\nKEY=value');
  assert.equal(upsertEnvValue('KEY=old\r\nOTHER=keep\r\n', 'KEY', 'new'), 'KEY=new\r\nOTHER=keep\r\n');
  assert.equal(upsertEnvValue('OTHER=keep', 'KEY', 'value'), 'OTHER=keep\nKEY=value');
  assert.equal(upsertEnvValue('KEY=old\n', 'KEY', 'a=b=c'), 'KEY=a=b=c\n');
  const same = 'KEY=value\nOTHER=keep\n';
  assert.equal(upsertEnvValue(same, 'KEY', 'value'), same);
  const sameWithFormatting = 'export KEY = "value"\nOTHER=keep\n';
  assert.equal(upsertEnvValue(sameWithFormatting, 'KEY', 'value'), sameWithFormatting);
});
