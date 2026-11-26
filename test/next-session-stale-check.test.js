import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractReferences, classifyLine, rebuildDocument,
  STATUS_RESOLVED, STATUS_PENDING, STATUS_UNKNOWN,
} from '../tools/next-session-stale-check.mjs';

test('PR #2826 を重複なしで抽出する', () => {
  assert.deepEqual(extractReferences('PR #2826 の MERGED 読み戻し'), { prNumbers: [2826], inboxIds: [] });
});

test('kim-inbox ID を抽出する', () => {
  assert.deepEqual(extractReferences('ki-20261126122725-71fd — 重複している判断依頼').inboxIds, ['ki-20261126122725-71fd']);
});

test('裸の #N を抽出し C#4 は除外する', () => {
  assert.deepEqual(extractReferences('#12 と C#4 と PR #12').prNumbers, [12]);
});

test('PR MERGED かつ inbox 回答済みは完了済み', () => {
  assert.equal(classifyLine('PR #2826 / ki-20261126122725-71fd', new Map([[2826, 'MERGED']]), new Map([['ki-20261126122725-71fd', 'answered']])), STATUS_RESOLVED);
});

test('PR OPEN は未決', () => {
  assert.equal(classifyLine('PR #2826', new Map([[2826, 'OPEN']]), new Map()), STATUS_PENDING);
});

test('参照なしは判定不能', () => {
  assert.equal(classifyLine('返信は送信済み', new Map(), new Map()), STATUS_UNKNOWN);
});

test('一部が OPEN でも別参照の照会失敗があれば判定不能', () => {
  assert.equal(classifyLine('PR #1 と PR #2', new Map([[1, 'OPEN'], [2, '照会失敗']]), new Map()), STATUS_UNKNOWN);
});

test('削除後は残った番号を1から振り直す', () => {
  const input = '## 残TODO\n1. PR #1\n2. PR #2\n3. PR #3\n';
  assert.equal(rebuildDocument(input, [2, 4]), '## 残TODO\n1. PR #2\n');
});

test('残TODO以外と対象外行は改行コードも含め完全一致する', () => {
  const input = '# 先頭\r\n## 次の1目的\r\n目的\r\n## 残TODO\r\n<!-- コメント -->\r\n1. PR #1\r\n補足は保持\r\n2. PR #2\r\n\r\n## 退避先\r\n[リンク](x)\r\n';
  const expected = '# 先頭\r\n## 次の1目的\r\n目的\r\n## 残TODO\r\n<!-- コメント -->\r\n補足は保持\r\n1. PR #2\r\n\r\n## 退避先\r\n[リンク](x)\r\n';
  assert.equal(rebuildDocument(input, [6]), expected);
});

test('残TODOがない文書は1文字も変えない', () => {
  const input = '## 次の1目的\n目的\n';
  assert.equal(rebuildDocument(input, []), input);
});
