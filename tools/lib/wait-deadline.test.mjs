import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestSafeStart, parseWaitFooter } from './wait-deadline.mjs';

const wait = 'まだ閉じない（作業中・2026-11-20 09:30 まで待つ';

test('フッターからローカル日時と作業時間を取り出す', () => {
  const { waitUntil, due, remainingMs, noDueReason } = parseWaitFooter(
    `本文\nこのセッション: ${wait}／納期 2026-11-21・残り作業 1.5日）\n`);
  assert.deepEqual(waitUntil, new Date(2026, 10, 20, 9, 30));
  assert.deepEqual(due, new Date(2026, 10, 21, 23, 59));
  assert.equal(remainingMs, 36 * 3_600_000);
  assert.equal(noDueReason, null);
  assert.equal(parseWaitFooter(`${wait}／納期 2026-11-21 06:00・残り作業 45分）`).remainingMs, 45 * 60_000);
  assert.equal(parseWaitFooter(`${wait}／納期 2026-11-31・残り作業 2時間）`).due, null);
  assert.equal(parseWaitFooter(`${wait}）`).due, null);
  assert.equal(parseWaitFooter('まだ閉じない（作業中・2026-02-30 09:30 まで待つ）').waitUntil, null);
});

test('納期なしには空白を除いて5文字以上の理由が必要', () => {
  assert.equal(parseWaitFooter(`${wait}／納期なし:  相手の回答時期が未定  ）`).noDueReason, '相手の回答時期が未定');
  assert.equal(parseWaitFooter(`${wait}／納期なし:  未定  ）`).noDueReason, null);
});

test('残作業の20%と最低1時間の大きい方を予備にする', () => {
  const due = new Date(2026, 10, 21, 18);
  assert.deepEqual(latestSafeStart(due, 2 * 3_600_000), new Date(2026, 10, 21, 15));
  assert.deepEqual(latestSafeStart(due, 10 * 3_600_000), new Date(2026, 10, 21, 6));
  assert.deepEqual(latestSafeStart(due, 10 * 3_600_000, 0.5), new Date(2026, 10, 21, 3));
  assert.equal(latestSafeStart(null, null), null);
});
