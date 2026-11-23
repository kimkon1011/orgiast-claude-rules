import test from 'node:test';
import assert from 'node:assert/strict';
import { markUngroundedActions, verifyActionGrounding } from '../../tools/next-actions.mjs';

// ============================================================
// verifyActionGrounding — 追加のエッジケース
// 基本ケースは test/next-actions-grounding.test.mjs でカバー済み
// ============================================================

test('first_step の対象システムが title/why と不一致なら検出する', () => {
  // title/why が backup 系、first_step が mail-relay 系
  const result = verifyActionGrounding({
    title: 'バックアップの結果を確認する',
    why: 'DailyDriveBackup の成否を検証するため',
    first_step: 'event-shop-mail-relay のログを確認する',
  });
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /first_step.*対象.*不一致/);
});

test('source/tag 経由でシステムが推論され first_step が一致する → 誤検知しない', () => {
  // tag に mail-relay が含まれるので、first_step の mail-relay は一致
  const result = verifyActionGrounding({
    title: '本番反映を確認',
    why: '動作を確認するため',
    first_step: 'D:\\Claude\\apps\\event-shop-mail-relay\\ を開く',
    source: 'event-shop-mail-relay',
    tag: 'mail-relay',
  }, { existsSync: () => true });
  assert.deepEqual(result, { ok: true, issues: [] });
});

test('tag 経由のシステムがあっても first_step が別システムなら不一致を検出する', () => {
  // tag に mail-relay → statedSystems は mail-relay, first_step は backup で不一致
  const result = verifyActionGrounding({
    title: '本番反映を確認',
    why: '動作を確認するため',
    first_step: 'バックアップの rclone ログを確認する',
    source: 'event-shop-mail-relay',
  });
  assert.equal(result.ok, false);
  assert.match(result.issues.join('\n'), /first_step.*対象.*不一致/);
});

test('システム不一致と絶対パス不在を同時に検出する', () => {
  const result = verifyActionGrounding({
    title: 'バックアップの結果を確認',
    why: 'バックアップ結果を検証するため',
    first_step: 'D:\\not-existent\\mail-relay\\log.txt を見る',
  }, { existsSync: () => false });
  assert.equal(result.ok, false);
  // 2件の issue があるはず
  assert.equal(result.issues.length, 2);
  assert.match(result.issues[0], /不一致/);
  assert.match(result.issues[1], /絶対パスが存在しない/);
});

test('first_step の絶対パス末尾の閉じ括弧・引用符を除去して存在確認する', () => {
  // コードの正規表現: /[)）\]】"']+$/ でパスの末尾除去
  // パス本体: C:\real-path\file.md の末尾に ) が付いている → 除去後 C:\real-path\file.md
  const result = verifyActionGrounding({
    title: 'PR#2567 を確認',
    why: 'PR 内容を確認するため',
    first_step: 'C:\\real-path\\file.md）',
  }, { existsSync: (p) => p === 'C:\\real-path\\file.md' });
  assert.deepEqual(result, { ok: true, issues: [] });
});

test('first_step に複数の絶対パスがあり両方とも存在しない', () => {
  let callCount = 0;
  const result = verifyActionGrounding({
    title: 'バックアップを確認',
    why: 'バックアップ結果を検証するため',
    first_step: 'Z:\\missing-a\\log.txt と C:\\missing-b\\report.txt を見る',
  }, { existsSync: () => { callCount++; return false; } });
  assert.equal(result.ok, false);
  assert.equal(callCount, 2);
  assert.match(result.issues[0], /missing-a/);
  assert.match(result.issues[1], /missing-b/);
});

test('action のプロパティが欠落していても例外を投げない', () => {
  assert.doesNotThrow(() => verifyActionGrounding({}));
  assert.doesNotThrow(() => verifyActionGrounding(undefined));
  assert.doesNotThrow(() => verifyActionGrounding(null));
  assert.doesNotThrow(() => verifyActionGrounding());
});

test('title にシステムが無く why にシステムがある → 不一致にならない', () => {
  const result = verifyActionGrounding({
    title: '確認する',
    why: 'バックアップ結果を検証するため',
    first_step: '確認コマンドを打つ',
  });
  assert.deepEqual(result, { ok: true, issues: [] });
});

test('システム語を含まない why と title は systemsIn が空 → 不一致判定にならない', () => {
  const result = verifyActionGrounding({
    title: '書類を確認する',
    why: '内容を確認するため',
    first_step: 'フォルダを開く',
  });
  assert.deepEqual(result, { ok: true, issues: [] });
});

// ============================================================
// markUngroundedActions — 追加のエッジケース
// ============================================================

test('空配列を渡すと空配列を返す', () => {
  assert.deepEqual(markUngroundedActions([]), []);
});

test('複数アクションで一部だけが grounded に失敗する', () => {
  const actions = [
    {
      title: 'PR#2567 を確認',
      why: '未処理PRを確認するため',
      first_step: 'gh pr view 2567',
    },
    {
      title: 'バックアップの確認',
      why: 'バックアップ結果を検証するため',
      first_step: 'D:\\Claude\\gas\\mail-relay を見る',
    },
  ];
  const result = markUngroundedActions(actions, { existsSync: () => true });
  assert.equal(result.length, 2);
  // 1つ目は grounded
  assert.deepEqual(result[0], actions[0]);
  // 2つ目は ungrounded（title=backup と step=mail-relay の不一致）
  assert.match(result[1].why, /^【裏取り未済】/);
  assert.equal(result[1].first_step, result[1].why);
});

test('複数 issue があるアクションの警告に全ての issue が含まれる', () => {
  const result = markUngroundedActions([{
    title: 'バックアップの確認',
    why: 'バックアップ結果を検証するため',
    first_step: 'D:\\missing\\mail-relay\\log.txt を見る',
  }], { existsSync: () => false });
  assert.equal(result.length, 1);
  assert.match(result[0].why, /不一致/);
  assert.match(result[0].why, /絶対パスが存在しない/);
});

test('正常なアクションは markUngroundedActions で変更されない', () => {
  const actions = [
    { title: 'バックアップを確認', why: 'バックアップ結果を検証するため', first_step: 'rclone のログを見る' },
    { title: 'PR#2567 をマージ', why: 'PR をマージするため', first_step: 'gh pr merge 2567' },
    { title: 'mail-relay を確認', why: 'メール中継の状態を確認', first_step: 'D:\\Claude\\gas\\event-shop-mail-relay の Code.gs を開く' },
  ];
  const result = markUngroundedActions(actions, { existsSync: () => true });
  assert.deepEqual(result, actions);
});