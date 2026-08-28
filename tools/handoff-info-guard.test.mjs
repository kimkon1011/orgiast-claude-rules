import test from 'node:test';
import assert from 'node:assert/strict';
import { findHandoffWithoutInfo, formatViolationMessage } from './handoff-info-guard.mjs';

test('過去参照だけでコマンドを再実行させる回帰ケースは tier A', () => {
  const result = findHandoffWithoutInfo('AI設定の配布に不具合がありました。お手数ですが、前回と同じコマンドをもう一度 PowerShell に貼って Enter してください');
  assert.equal(result?.tier, 'A');
});

test('情報なしでリモートPCに実行を頼むと tier B', () => {
  assert.equal(findHandoffWithoutInfo('リモートPCでもう一度実行してください')?.tier, 'B');
});

test('情報なしで Discord の設定作業を頼むと tier B', () => {
  assert.equal(findHandoffWithoutInfo('Discord にログインして設定を有効にしてください')?.tier, 'B');
});

test('名詞形の依頼語尾も tier B', () => {
  assert.equal(findHandoffWithoutInfo('リモートPCでコマンドの実行をお願いします')?.tier, 'B');
});

test('依頼と同じ本文に URL があれば違反にしない', () => {
  const text = '前回と同じコマンドをもう一度 PowerShell に貼って Enter してください。https://example.com/setup';
  assert.equal(findHandoffWithoutInfo(text), null);
});

test('依頼と同じ本文にコマンド全文のコードブロックがあれば違反にしない', () => {
  const text = 'リモートPCでもう一度実行してください。\n```powershell\nnode tools/setup.mjs --force\n```';
  assert.equal(findHandoffWithoutInfo(text), null);
});

test('完了報告のみは違反にしない', () => {
  assert.equal(findHandoffWithoutInfo('修正して push しました。CI も緑です'), null);
});

test('Claude 自身の行為は違反にしない', () => {
  assert.equal(findHandoffWithoutInfo('私がリモートで実行して確認しました'), null);
});

test('HANDOFF-INFO-OK があれば常に違反にしない', () => {
  assert.equal(findHandoffWithoutInfo('前回と同じ手順を実行してください。[HANDOFF-INFO-OK]'), null);
});

test('コードレビュー中の技術説明は違反にしない', () => {
  assert.equal(findHandoffWithoutInfo('この関数は設定して返しているため、副作用はありません'), null);
});

test('違反なしのメッセージは空文字', () => {
  assert.equal(formatViolationMessage(null), '');
});

test('tier A のメッセージは過去参照を指摘する', () => {
  const message = formatViolationMessage({ tier: 'A', reasons: ['x'] });
  assert.match(message, /前回と同じ/);
  assert.match(message, /過去を参照/);
});
