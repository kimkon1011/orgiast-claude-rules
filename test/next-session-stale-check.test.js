import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractReferences, classifyLine, rebuildDocument, annotatePartials, partialNotes,
  STATUS_RESOLVED, STATUS_PENDING, STATUS_PARTIAL, STATUS_UNKNOWN,
} from '../tools/next-session-stale-check.mjs';

test('PR #2826 を重複なしで抽出する', () => {
  assert.deepEqual(extractReferences('PR #2826 の MERGED 読み戻し'), { prNumbers: [2826], inboxIds: [], mailIds: [] });
});

test('kim-inbox ID を抽出する', () => {
  assert.deepEqual(extractReferences('ki-20261126122725-71fd — 重複している判断依頼').inboxIds, ['ki-20261126122725-71fd']);
});

test('fleet-mail ID を抽出する', () => {
  assert.deepEqual(extractReferences('mail-20261126122725-71fd の確認').mailIds, ['mail-20261126122725-71fd']);
});

test('fleet-mail ID と PR を同時に抽出する', () => {
  const result = extractReferences('PR #123 / mail-20261126122725-71fd の確認');
  assert.deepEqual(result.prNumbers, [123]);
  assert.deepEqual(result.mailIds, ['mail-20261126122725-71fd']);
  assert.deepEqual(result.inboxIds, []);
});

test('裸の #N を抽出し C#4 は除外する', () => {
  assert.deepEqual(extractReferences('#12 と C#4 と PR #12').prNumbers, [12]);
});

test('PR MERGED かつ inbox 回答済みは完了済み', () => {
  assert.equal(classifyLine('PR #2826 / ki-20261126122725-71fd', new Map([[2826, 'MERGED']]), new Map([['ki-20261126122725-71fd', 'answered']]), new Map()), STATUS_RESOLVED);
});

test('mail が delivered で他参照なしは完了済み', () => {
  assert.equal(classifyLine('mail-20261126122725-71fd', new Map(), new Map(), new Map([['mail-20261126122725-71fd', 'delivered']])), STATUS_RESOLVED);
});

test('mail が expired も完了済み（端末状態）', () => {
  assert.equal(classifyLine('mail-20261126122725-71fd', new Map(), new Map(), new Map([['mail-20261126122725-71fd', 'expired']])), STATUS_RESOLVED);
});

test('mail が pending は未決', () => {
  assert.equal(classifyLine('mail-20261126122725-71fd', new Map(), new Map(), new Map([['mail-20261126122725-71fd', 'pending']])), STATUS_PENDING);
});

test('PR OPEN は未決', () => {
  assert.equal(classifyLine('PR #2826', new Map([[2826, 'OPEN']]), new Map(), new Map()), STATUS_PENDING);
});

test('PR MERGED だが mail pending は一部完了', () => {
  assert.equal(classifyLine('PR #1 / mail-20261126122725-71fd', new Map([[1, 'MERGED']]), new Map(), new Map([['mail-20261126122725-71fd', 'pending']])), STATUS_PARTIAL);
});

test('mail delivered だが PR OPEN も一部完了', () => {
  assert.equal(classifyLine('mail-20261126122725-71fd / PR #1', new Map([[1, 'OPEN']]), new Map(), new Map([['mail-20261126122725-71fd', 'delivered']])), STATUS_PARTIAL);
});

test('inbox answered だが PR OPEN は一部完了', () => {
  assert.equal(classifyLine('PR #1 / ki-20261126122725-71fd', new Map([[1, 'OPEN']]), new Map([['ki-20261126122725-71fd', 'answered']]), new Map()), STATUS_PARTIAL);
});

test('参照なしは判定不能', () => {
  assert.equal(classifyLine('返信は送信済み', new Map(), new Map(), new Map()), STATUS_UNKNOWN);
});

test('一部が OPEN でも別参照の照会失敗があれば判定不能', () => {
  assert.equal(classifyLine('PR #1 と PR #2', new Map([[1, 'OPEN'], [2, '照会失敗']]), new Map(), new Map()), STATUS_UNKNOWN);
});

test('partialNotes は MERGED の PR だけを注釈に含める', () => {
  const line = 'PR #1 / mail-20261126122725-71fd';
  const note = partialNotes(line, new Map([[1, 'MERGED']]), new Map(), new Map([['mail-20261126122725-71fd', 'pending']]));
  assert.ok(note.includes('PR #1'));
  assert.ok(!note.includes('mail-'));
});

test('partialNotes は解決した mail も含める', () => {
  const line = 'mail-20261126122725-71fd / PR #1';
  const note = partialNotes(line, new Map([[1, 'OPEN']]), new Map(), new Map([['mail-20261126122725-71fd', 'delivered']]));
  assert.ok(note.includes('mail-20261126122725-71fd'));
  assert.ok(!note.includes('PR #1'));
});

test('annotatePartials は対象行の末尾に注釈を追記する', () => {
  const input = '## 残TODO\n1. PR #1 / mail test\n2. PR #2\n';
  const map = new Map([['1. PR #1 / mail test', '（部分完了: PR #1）']]);
  const output = annotatePartials(input, map);
  assert.ok(output.includes('（部分完了: PR #1）'));
  assert.ok(!output.includes('PR #2  （部分'));
});

test('annotatePartials は対象外行を一切変えない', () => {
  const input = '## 残TODO\n1. PR #1\n2. PR #2\n';
  assert.equal(annotatePartials(input, new Map()), input);
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