import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePendingActions } from './pending-actions-notice.mjs';

const today = new Date(2026, 8, 4, 12, 0, 0);

test('空文字列と未処理0件は空になる', () => {
  assert.deepEqual(parsePendingActions('', today), []);
  assert.deepEqual(parsePendingActions('- [x] 2026-09-04 | 完了済み', today), []);
});

test('今日以前の未処理だけを返し、未来・完了・壊れた行を無視する', () => {
  const text = [
    '- [ ] 2026-09-01 | 購入する | https://example.com',
    '- [ ] 2026-09-05 | 未来の作業',
    '- [x] 2026-09-01 | 完了済み',
    '- [ ] 日付なし | 壊れた行',
    '- [ ] 2026-09-01',
    '- [ ] 2026-02-30 | 存在しない日付',
  ].join('\n');

  assert.deepEqual(parsePendingActions(text, today), [{
    dueDate: '2026-09-01',
    subject: '購入する',
    details: ['https://example.com'],
    elapsedDays: 3,
  }]);
});

test('補足0個と補足3個以上を正しくパースする', () => {
  const text = [
    '- [ ] 2026-09-03 | 補足なし',
    '- [ ] 2026-09-02 | 補足あり | URL | メモ1 | メモ2',
  ].join('\n');

  assert.deepEqual(parsePendingActions(text, today), [
    { dueDate: '2026-09-03', subject: '補足なし', details: [], elapsedDays: 1 },
    { dueDate: '2026-09-02', subject: '補足あり', details: ['URL', 'メモ1', 'メモ2'], elapsedDays: 2 },
  ]);
});

test('期日がちょうど今日の項目を含める', () => {
  assert.deepEqual(parsePendingActions('- [ ] 2026-09-04 | 今日の作業', today), [{
    dueDate: '2026-09-04',
    subject: '今日の作業',
    details: [],
    elapsedDays: 0,
  }]);
});
