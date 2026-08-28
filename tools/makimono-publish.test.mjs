import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { notifyStale, reconcileSubmissions } from './makimono-publish.mjs';

const NOW = new Date('2026-08-27T12:00:00.000Z');
const pending = (overrides = {}) => ({ at: '2026-08-26T12:00:00.000Z', title: 'ＡＢＣ　手順', submissionId: 'sub_dummy', status: 'pending', ...overrides });

test('タイトルの全角半角と空白差を正規化して published に更新する', () => {
  const result = reconcileSubmissions([pending()], [{ title: 'abc手順', slug: 'abc-guide' }], NOW, 3);
  assert.equal(result.published, 1);
  assert.deepEqual(result.logs[0], { ...pending(), status: 'published', slug: 'abc-guide', publishedSeenAt: NOW.toISOString() });
});

test('既に published のエントリは再判定しない', () => {
  const existing = pending({ status: 'published', slug: 'original', publishedSeenAt: '2026-08-20T00:00:00.000Z' });
  const result = reconcileSubmissions([existing], [{ title: 'abc手順', slug: 'replacement' }], NOW, 3);
  assert.equal(result.logs[0], existing);
  assert.deepEqual(result.logs[0], existing);
});

test('staleDays は超過だけを stale とする', () => {
  const logs = [
    pending({ title: 'ちょうど3日', at: '2026-08-24T12:00:00.000Z' }),
    pending({ title: '4日', at: '2026-08-23T12:00:00.000Z' }),
  ];
  const result = reconcileSubmissions(logs, [], NOW, 3);
  assert.deepEqual(result.pendingItems.map((item) => [item.days, item.stale]), [[3, false], [4, true]]);
  assert.equal(result.stale, 1);
});

test('入力配列とエントリを破壊しない', () => {
  const logs = [pending()];
  const snapshot = structuredClone(logs);
  reconcileSubmissions(logs, [{ title: 'abc手順', slug: 'abc-guide' }], NOW, 3);
  assert.deepEqual(logs, snapshot);
});

test('公開側一覧が空でも例外を投げない', () => {
  assert.doesNotThrow(() => reconcileSubmissions([pending()], [], NOW, 3));
  const result = reconcileSubmissions([pending()], [], NOW, 3);
  assert.equal(result.pending, 1);
  assert.equal(result.published, 0);
});

function notifyFixture(ids) {
  return { pending: ids.length, stale: ids.length, pendingItems: ids.map((submissionId) => ({ submissionId, title: submissionId, stale: true })) };
}
function notifyHarness() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'makimono-notify-'));
  const stateFile = path.join(root, '.claude', 'makimono-notify-state.json');
  const calls = [];
  process.env.ORGIAST_HOME = root;
  return { root, stateFile, calls, webhookUrl: 'https://example.com/test-webhook', fetchImpl: async (...args) => { calls.push(args); return { ok: true, status: 204 }; } };
}

test('同じ stale 集合の2回目は通知しない', async () => {
  const h = notifyHarness(); const options = { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: NOW };
  await notifyStale(notifyFixture(['a']), 3, options);
  await notifyStale(notifyFixture(['a']), 3, { ...options, now: new Date(NOW.getTime() + DAY) });
  assert.equal(h.calls.length, 1);
});

const DAY = 24 * 60 * 60 * 1000;
test('stale ID が増えたら通知する', async () => {
  const h = notifyHarness();
  await notifyStale(notifyFixture(['a']), 3, { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: NOW });
  await notifyStale(notifyFixture(['a', 'b']), 3, { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: new Date(NOW.getTime() + DAY) });
  assert.equal(h.calls.length, 2);
});

test('7日経過で再通知する', async () => {
  const h = notifyHarness();
  await notifyStale(notifyFixture(['a']), 3, { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: NOW });
  await notifyStale(notifyFixture(['a']), 3, { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: new Date(NOW.getTime() + 7 * DAY) });
  assert.equal(h.calls.length, 2);
});

test('forceNotify は同内容でも強制通知する', async () => {
  const h = notifyHarness();
  await notifyStale(notifyFixture(['a']), 3, { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: NOW });
  await notifyStale(notifyFixture(['a']), 3, { fetchImpl: h.fetchImpl, webhookUrl: h.webhookUrl, now: NOW, forceNotify: true });
  assert.equal(h.calls.length, 2);
});
