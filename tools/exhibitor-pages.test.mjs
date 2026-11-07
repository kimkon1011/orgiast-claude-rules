import test from 'node:test';
import assert from 'node:assert/strict';
import { extractPages } from './exhibitor-pages.mjs';

const row = id => ({ id, company: `Company ${id}`, booth: 'A1', description: 'Machine maker', website: 'https://example.com' });
const capture = () => ({ total: 2, pages: [0, 1].map(offset => ({ offset, total: 2, source: 'https://example.com/exhibitors', fetchedAt: '2026-11-07T00:00:00Z', rows: [row(String(offset))] })) });

test('local capture preserves records and provenance across pages', () => {
  const result = extractPages(capture());
  assert.equal(result.complete, true);
  assert.equal(result.uniqueIds, 2);
  assert.deepEqual(result.rows.map(r => r.id), ['0', '1']);
  assert.equal(result.rows[1].fetchedAt, '2026-11-07T00:00:00Z');
});

test('equal record count cannot hide page gaps, duplicates, missing fields or fetch errors', () => {
  const cases = [
    ['page-gap-or-overlap', c => { c.pages[1].offset = 2; }],
    ['duplicate-id', c => { c.pages[1].rows[0].id = '0'; }],
    ['missing-fields', c => { delete c.pages[1].rows[0].website; }],
    ['fetch-error', c => { c.pages[1].error = 'timeout'; }],
    ['total-mismatch', c => { c.pages[1].total = 3; }],
    ['invalid-provenance-or-url', c => { c.pages[1].fetchedAt = 'yesterday'; }],
    ['count-mismatch', c => { c.pages.pop(); }],
  ];
  for (const [type, mutate] of cases) {
    const input = capture(); mutate(input);
    const result = extractPages(input);
    assert.equal(result.complete, false, type);
    assert.ok(result.issues.some(issue => issue.type === type), type);
  }
  assert.throws(() => extractPages({ total: 2, pages: [] }));
});
