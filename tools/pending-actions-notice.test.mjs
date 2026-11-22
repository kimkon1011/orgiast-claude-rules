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

test('notice uses the final-only instruction and suppresses loop and repeated prompts', async t => {
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const { pendingActionsContext } = await import('./pending-actions-notice.mjs');
  const { FINAL_ONLY_INSTRUCTION } = await import('./lib/inbox-display-policy.mjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-notice-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/pending-user-actions.md'), '- [ ] 2020-01-01 | action');
  const input = { session_id: 's', prompt: 'request' };
  const out = pendingActionsContext(input, { home });
  assert.ok(out.hookSpecificOutput.additionalContext.includes(FINAL_ONLY_INSTRUCTION));
  assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /応答の冒頭/);
  assert.equal(pendingActionsContext(input, { home }), null);
  assert.equal(pendingActionsContext({ ...input, prompt: '<<autonomous-loop-dynamic>>' }, { home }), null);
});
