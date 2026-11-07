import test from 'node:test';
import assert from 'node:assert/strict';
import { selectContacts } from './exhibitor-contacts.mjs';
const contact = (id, extra = {}) => ({ id, companyId: 'a', employees: 25, companyType: 'manufacturer', crmStatus: 'uncontacted', crmEvidence: 'fixture-crm', roleEvidence: 'fixture-role', boothEvidence: 'fixture-booth', postsStatus: 'ok', posts: Array.from({length: 5}, (_, i) => ({ publishedAt: '2026-09-08T00:00:00Z', source: `https://example.com/post/${i}` })), ...extra });
const run = contacts => selectContacts({referenceAt: '2026-11-07T00:00:00Z', contacts});
test('CRM, role and booth evidence must be nonblank strings', () => {
  for (const field of ['crmEvidence', 'roleEvidence', 'boothEvidence']) {
    for (const value of [' ', '\t\n', true, 123, {}, []]) {
      const [row] = run([contact('x', {[field]: value})]);
      assert.equal(row.status, 'review', field);
      assert.equal(row.fetchFullProfile, false, field);
      assert.deepEqual(row.reasons, [field === 'crmEvidence' ? 'unknown-crm' : 'unknown-role-or-booth-authority']);
    }
  }
});
test('inclusive employee/activity boundaries, duplicate and per-company cap', () => {
  const rows = run([contact('1'), contact('2', {employees: 250}), contact('3'), contact('4'), contact('1')]);
  assert.deepEqual(rows.map(r => r.status), ['eligible','eligible','eligible','excluded','excluded']);
  assert.deepEqual(rows[3].reasons, ['company-cap']);
  assert.ok(rows[4].reasons.includes('duplicate-contact'));
});
test('five posts require distinct nonblank source identifiers', () => {
  const original = contact('x').posts;
  for (const source of [original[0].source, ` ${original[0].source} `, '   ', 123]) {
    const posts = original.map((p, i) => i === 4 ? {...p, source} : p);
    const [row] = run([contact('x', {posts})]);
    assert.equal(row.status, 'review');
    assert.deepEqual(row.reasons, ['invalid-five-posts']);
    assert.equal(row.fetchFullProfile, false);
  }
});
test('unknown evidence and fetch failure never permit full profile; exclusions are explicit', () => {
  const cases = [
    [{employees:24}, 'employee-range'], [{employees:251}, 'employee-range'],
    [{employees:null}, 'unknown-employees'], [{crmStatus:undefined}, 'unknown-crm'],
    [{crmEvidence:''}, 'unknown-crm'], [{crmStatus:'contacted'}, 'already-contacted'],
    ...['distributor','association','media'].map(companyType => [{companyType}, 'excluded-company']),
    [{companyType:undefined}, 'unknown-company-type'], [{boothEvidence:''}, 'unknown-role-or-booth-authority'],
    [{postsStatus:'timeout'}, 'posts-fetch-failed-or-unknown'], [{posts:[]}, 'invalid-five-posts'],
    [{posts:contact('old').posts.map(p => ({...p, publishedAt:'2026-09-07T23:59:59Z'}))}, 'inactive'],
    [{posts:contact('future').posts.map(p => ({...p, publishedAt:'2026-11-08T00:00:00Z'}))}, 'invalid-five-posts'],
  ];
  for (const [extra, reason] of cases) {
    const [row] = run([contact('x', extra)]);
    assert.equal(row.fetchFullProfile, false, reason);
    assert.ok(row.reasons.includes(reason), reason);
    if (reason === 'posts-fetch-failed-or-unknown') assert.equal(row.status, 'review');
  }
});
