import assert from 'node:assert/strict';
import test from 'node:test';

import { run } from './orchestrate.mjs';

function fixture() {
  return {
    exhibitors: [
      { name: 'Fiction Forge', description: 'Makes imaginary sensors', website: 'https://fiction.invalid' },
      { name: 'Paper Media', description: 'Industry media', website: 'https://paper.invalid' },
    ],
    companies: [
      { name: 'Fiction Forge', employees: 80 },
      { name: 'Paper Media', employees: 90 },
    ],
    contacts: [
      { company: 'Fiction Forge', name: 'Aki Example', title: 'VP of Sales', posts: [{ date: '2026-10-01' }] },
      { company: 'Paper Media', name: 'Bo Example', title: 'Founder', posts: [{ date: '2026-10-01' }] },
    ],
    referenceDate: '2026-11-01',
  };
}

function deps(calls) {
  return {
    fetchSiteText: (website) => { calls.fetch.push(website); return 'fictional site text'; },
    extractInsights: (text) => { calls.extract.push(text); return { sellsTo: 'factories', buyer: 'leaders', reason: 'speed' }; },
    generateDraft: (analysis, title) => { calls.draft.push({ analysis, title }); return 'fixed draft'; },
  };
}

test('C6: fixture dry-run records every stage and reaches C5', () => {
  const calls = { fetch: [], extract: [], draft: [] };
  const result = run(fixture(), deps(calls));
  assert.deepEqual(result.stages, { normalized: 2, filtered: 2, cleansed: 1, fresh: 1, analyzed: 1, drafted: 1 });
  assert.deepEqual(result.details, [{
    company: 'Fiction Forge', contact: 'Aki Example', title: 'VP of Sales',
    analysis: { sellsTo: 'factories', buyer: 'leaders', reason: 'speed' }, draft: 'fixed draft',
  }]);
  assert.deepEqual(calls.fetch, ['https://fiction.invalid']);
  assert.deepEqual(calls.extract, ['fictional site text']);
  assert.equal(calls.draft.length, 1);
});

test('C6: missing deps throws TypeError', () => {
  assert.throws(() => run(fixture()), TypeError);
});

test('C6: empty arrays produce zero counts without external calls', () => {
  const calls = { fetch: [], extract: [], draft: [] };
  const result = run({ exhibitors: [], companies: [], contacts: [] }, deps(calls));
  assert.deepEqual(result, {
    stages: { normalized: 0, filtered: 0, cleansed: 0, fresh: 0, analyzed: 0, drafted: 0 },
    details: [],
  });
  assert.deepEqual(calls, { fetch: [], extract: [], draft: [] });
});
