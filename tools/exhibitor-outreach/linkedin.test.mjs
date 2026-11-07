import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyFreshness, selectFullProfileTargets } from './linkedin.mjs';

test('C4: 59, 60, and 61 day boundaries are classified exactly', () => {
  const reference = '2026-03-02';
  assert.deepEqual(classifyFreshness([{ date: '2026-01-02' }], reference), { eligible: true, daysSinceLatest: 59 });
  assert.deepEqual(classifyFreshness([{ date: '2026-01-01' }], reference), { eligible: true, daysSinceLatest: 60 });
  assert.deepEqual(classifyFreshness([{ date: '2025-12-31' }], reference), { eligible: false, daysSinceLatest: 61 });
});

test('C4: latest date wins among the first five even when posts are oldest first', () => {
  const posts = ['2025-01-01', '2025-06-01', '2025-09-01', '2025-12-01', '2026-02-20']
    .map((date) => ({ date }));
  assert.deepEqual(classifyFreshness(posts, '2026-03-02'), { eligible: true, daysSinceLatest: 10 });
});

test('C4: a fresh sixth post is ignored', () => {
  const posts = [
    { date: '2025-01-01' }, { date: '2025-01-02' }, { date: '2025-01-03' },
    { date: '2025-01-04' }, { date: '2025-01-05' }, { date: '2026-03-02' },
  ];
  assert.deepEqual(classifyFreshness(posts, '2026-03-02'), { eligible: false, daysSinceLatest: 421 });
});

test('C4: zero posts and invalid-only posts have no latest date', () => {
  assert.deepEqual(classifyFreshness([], '2026-03-02'), { eligible: false, daysSinceLatest: null });
  assert.deepEqual(classifyFreshness([{ date: 'invalid' }, { date: '2026-02-30' }], '2026-03-02'), {
    eligible: false,
    daysSinceLatest: null,
  });
});

test('C4: omitted reference date throws', () => {
  assert.throws(() => classifyFreshness([]), /referenceDate/);
});

test('C4: future posts have negative age and remain eligible', () => {
  assert.deepEqual(classifyFreshness([{ date: '2026-03-05' }], '2026-03-02'), {
    eligible: true,
    daysSinceLatest: -3,
  });
});

test('C4: Date and string reference dates use the same UTC calendar day', () => {
  const posts = [{ date: '2026-01-01' }];
  const expected = { eligible: true, daysSinceLatest: 60 };
  assert.deepEqual(classifyFreshness(posts, '2026-03-02'), expected);
  assert.deepEqual(classifyFreshness(posts, new Date('2026-03-02T23:30:00-08:00')), {
    eligible: false,
    daysSinceLatest: 61,
  });
});

test('C4: full profile targets include only eligible names', () => {
  const profiles = [
    { name: 'Amber Circuit', posts: [{ date: '2026-02-01' }] },
    { name: 'Cobalt Orchard', posts: [{ date: '2025-01-01' }] },
    { name: 'Quartz Finch', posts: [{ date: '2026-03-03' }] },
  ];
  assert.deepEqual(selectFullProfileTargets(profiles, '2026-03-02'), ['Amber Circuit', 'Quartz Finch']);
});
