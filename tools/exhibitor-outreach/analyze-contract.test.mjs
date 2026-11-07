import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { analyzeSite, composeDraft } from './analyze.mjs';

test('C5: extractInsights stub returns normalized fixed insights', async () => {
  const holdout = JSON.parse(await readFile(
    new URL('./fixtures/analyze-holdout.json', import.meta.url),
    'utf8',
  ));
  let received = null;
  const result = analyzeSite(holdout.siteText, {
    extractInsights: (text) => { received = text; return holdout.expected; },
  });
  assert.equal(received, holdout.siteText);
  assert.deepEqual(result, holdout.expected);
});

test('C5: composeDraft returns the generateDraft stub value', () => {
  const analysis = { sellsTo: 'labs', buyer: 'directors', reason: 'speed' };
  let received = null;
  const result = composeDraft(analysis, 'VP of Sales', {
    generateDraft: (...args) => { received = args; return 'fixed draft'; },
  });
  assert.equal(result, 'fixed draft');
  assert.deepEqual(received, [analysis, 'VP of Sales']);
});

test('C5: empty and null site text return null fields without calling the stub', () => {
  const deps = { extractInsights: () => { throw new Error('must not be called'); } };
  const empty = { sellsTo: null, buyer: null, reason: null };
  assert.deepEqual(analyzeSite('', deps), empty);
  assert.deepEqual(analyzeSite(null, deps), empty);
});

test('C5: null extractor response returns null fields', () => {
  assert.deepEqual(analyzeSite('site text', { extractInsights: () => null }), {
    sellsTo: null, buyer: null, reason: null,
  });
});
