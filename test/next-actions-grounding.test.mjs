import test from 'node:test';
import assert from 'node:assert/strict';
import { markUngroundedActions, runNextActions, verifyActionGrounding } from '../tools/next-actions.mjs';

test('PR マージの title とバックアップ停止の why を不一致として検出する', () => {
  const result = verifyActionGrounding({
    title: 'PR#2567 をマージする',
    why: '重要なバックアップが止まっているため',
    first_step: 'gh pr view 2567',
  });
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /title.*why.*不一致/);
});

test('first_step の実在しない絶対パスを検出する', () => {
  const result = verifyActionGrounding({
    title: 'バックアップを確認',
    why: 'バックアップ結果を検証するため',
    first_step: 'Z:\\definitely-missing\\backup.log を開く',
  }, { existsSync: () => false });
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /絶対パスが存在しない/);
});

test('title・why・first_step が同じシステムなら誤検知しない', () => {
  const result = verifyActionGrounding({
    title: 'event-shop-mail-relay を確認',
    why: 'mail-relay の応答を検証するため',
    first_step: 'D:\\Claude\\gas\\event-shop-mail-relay の Code.gs を開く',
  }, { existsSync: () => true });
  assert.deepEqual(result, { ok: true, issues: [] });
});

test('不一致時は既存行形式を保ち、元の why / first_step を警告へ置き換える', () => {
  const [action] = markUngroundedActions([{
    title: 'PR#2567 をマージする',
    why: 'バックアップが止まっているため',
    first_step: 'D:\\Claude\\gas\\event-shop-mail-relay のログを見る',
    source: 'PR#2567',
  }], { existsSync: () => true });
  assert.match(action.why, /^【裏取り未済】/);
  assert.equal(action.first_step, action.why);
  assert.doesNotMatch(action.why, /バックアップが止まっているため$/);
});

test('正常な推奨アクション出力は従来どおり', async () => {
  const output = [];
  const action = {
    title: 'PR#2567 を確認',
    why: '未処理PRを確認するため',
    first_step: 'gh pr view 2567',
    source: 'PR#2567',
  };
  const result = await runNextActions({
    args: ['--dry-run'],
    home: 'C:\\test-home',
    now: new Date('2026-11-24T00:00:00+09:00'),
    llm: async () => ({ provider: 'groq', text: JSON.stringify({ actions: [action] }) }),
    execImpl: (_file, args, _options, callback) => callback(null,
      args[0] === 'pr' && args[1] === 'view'
        ? JSON.stringify({ number: parseInt(args[2]), state: 'OPEN' })
        : '[]'),
    listLedger: async () => ({ ok: true, rows: [] }),
    log: value => output.push(value),
    error: () => {},
  });
  assert.match(result.body, /1\. PR#2567 を確認 \[PR#2567\]\n   - why: 未処理PRを確認するため\n   - first_step: gh pr view 2567/);
  assert.doesNotMatch(result.body, /裏取り未済/);
});
