import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateDelegationReadback as evaluate } from './delegation-readback-gate.mjs';

for (const text of [
  'Codex に委譲して実装しました。',
  'codex-do で回しました。修正しました。',
  'cheap-code に頼みました。変更しました。',
  'deepseek で処理してもらい、追加しました。',
  'gemini-cli に作業を依頼しました。作成しました。',
  'Codex へ実装を依頼しました。反映しました。',
]) test(`blocks: ${text}`, () => assert.equal(evaluate(text).decision, 'block'));

for (const text of [
  'Codex に委譲して実装しました。git diff で3ファイルの変更を確認しました。',
  'codex-do の後に git status を読み戻し、変更しました。',
  'deepseek で修正しました。[READBACK: 変更主張 => git diff の該当hunk]',
  'gemini-cli に作成してもらい、node --test が全部 pass しました。',
  'cheap-code が変更しました。変更ファイル 3 件を確認済みです。',
  '実装しました。',
  '修正しました。委譲はしていません。',
]) test(`passes: ${text}`, () => assert.equal(evaluate(text).decision, 'pass'));

test('引用除外: コードフェンス内の委譲+完了主張は pass', () => {
  assert.equal(evaluate('```\ncodex-do\n実装しました\n```').decision, 'pass');
});

test('引用除外: 行頭 > の引用行と「」囲みは検査しない', () => {
  assert.equal(evaluate('> Codex に委譲して実装しました。').decision, 'pass');
  assert.equal(evaluate('過去の報告「委譲して実装しました」は誤りでした。').decision, 'pass');
});

test('[DELEGATE-READBACK-OK] 調査のみで実装していない がある → pass', () => {
  assert.equal(evaluate('[DELEGATE-READBACK-OK] 調査のみで実装していない\nCodex に委譲予定でしたが変更しました').decision, 'pass');
});

test('OK タグは10文字以上の理由が要る', () => {
  assert.equal(evaluate('[DELEGATE-READBACK-OK] 短い\nCodex に委譲して実装しました').decision, 'block');
});

test('否定文脈（委譲しない/委譲せず/委譲は不要）は委譲検出から外す', () => {
  assert.equal(evaluate('Codex へ委譲せず自前で実装しました').decision, 'pass');
  assert.equal(evaluate('今回は委譲しない方針で修正しました').decision, 'pass');
  assert.equal(evaluate('この規模なら委譲は不要です。追加しました').decision, 'pass');
});

test('block 理由と code を返す', () => {
  const result = evaluate('Codex に委譲して実装しました。');
  assert.equal(result.code, 'DELEGATE-READBACK');
  assert.ok(result.reason.includes('[DELEGATE-READBACK-OK]'));
});
