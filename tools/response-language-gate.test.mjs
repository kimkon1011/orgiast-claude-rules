import assert from 'node:assert/strict';
import test from 'node:test';
import { judgeResponseLanguage, judgeTurnLanguage } from './response-language-gate.mjs';

const japanese = { settings: { language: 'japanese' } };
const longEnglish = 'The implementation is complete and all related tests passed successfully. The configuration was deployed and verified on every target computer without overwriting any unrelated user preference or existing hook registration.';

test('英語報告を block する', () => {
  const result = judgeResponseLanguage(longEnglish, '', japanese);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'RESPONSE-LANGUAGE');
  assert.equal(result.reason, '応答が日本語ではありません。user の言語設定は日本語です。説明文・報告・質問はすべて日本語で書き直してください（コード・識別子・コマンドは原文のままでよい）。Stop hook の差し戻しで書き直すときも日本語を保つこと。');
});

test('日本語報告を pass する', () => {
  assert.equal(judgeResponseLanguage('実装と関連テストが完了し、全PCへの設定配布も確認しました。', '', japanese).decision, 'pass');
});

test('大きなコードブロック・英語識別子・パス・URL を含む日本語報告を pass する', () => {
  const text = ['実装と検証が完了しました。次のコードは変更例です。', '```js', 'const extremelyLongEnglishIdentifier = createResponseLanguageConfigurationForEveryComputer();'.repeat(8), '```', '対象は `responseLanguageConfigurationIdentifier`、C:\\Users\\kimko\\project\\tools\\response-language-gate.mjs、/home/runner/work/project/tools/response-language-gate.mjs、[確認先](https://example.com/very/long/english/path?with=parameters) です。'].join('\n');
  assert.equal(judgeResponseLanguage(text, '', japanese).decision, 'pass');
});

test('短い英語は pass する', () => assert.equal(judgeResponseLanguage('OK. All tests passed.', '', japanese).decision, 'pass'));

test('human が英語で settings も日本語でなければ英語応答を pass する', () => {
  assert.equal(judgeResponseLanguage(longEnglish, 'Please give me the report in English.', { settings: {} }).decision, 'pass');
});

test('2026-10-26 の実害サンプルを block する', () => {
  const text = "The design document is ready, with D5 (Timee's terms of use) now confirmed. Only the five items D1, D2, D3, D4 and D6 above are left for you to decide. If the recommended options are fine, reply \"OK\". If you want to change any, tell me its number.";
  assert.equal(judgeResponseLanguage(text, '', japanese).decision, 'block');
});

const footer = ['恒久策: 一回限り: 設計書の承認は案件ごとに1回だけの判断で今後同じ作業は発生しない', '', '次に kim がすること: D1〜D6 の推奨案で良いか返事をする', 'この後の自動進行: なし', 'このセッション: まだ閉じない（作業中）'].join('\n');

test('2026-10-26 実害: 本文英語＋日本語の定型フッターでも block する', () => {
  const body = "The design document is ready, with D5 (Timee's terms of use) now confirmed. Only the five items D1, D2, D3, D4 and D6 above are left for you to decide. If the recommended options are fine, reply \"OK\". If you want to change any, tell me its number.";
  assert.equal(judgeResponseLanguage(`${body}\n\n${footer}`, '', japanese).decision, 'block');
});

test('2026-10-26 実害: 短い英語本文＋タグ行＋日本語フッターでも block する', () => {
  const body = 'The only thing that moves forward next is your reply, so nothing runs automatically. Once you reply "OK", I\'ll create tasklist.md (the list of implementation tasks).';
  assert.equal(judgeResponseLanguage(`${body}\n\n[NO-TEST-OK: reason]\n\n${footer}`, '', japanese).decision, 'block');
});

test('日本語本文＋定型フッターは pass する', () => {
  assert.equal(judgeResponseLanguage(`設計書の D5 を確認しました。残りの判断は D1〜D6 の推奨案で良いかだけです。\n\n${footer}`, '', japanese).decision, 'pass');
});

test('ターン途中の英語の経過報告も block する（最終メッセージが日本語でも）', () => {
  const interim = "I'll make the change in a separate working copy built from the latest upstream main, then run the tests and replay real replies.";
  assert.equal(judgeTurnLanguage([interim, `修正して検証しました。\n\n${footer}`], '', japanese).decision, 'block');
  assert.equal(judgeTurnLanguage(['作業ツリーを作って修正します。', `修正して検証しました。\n\n${footer}`], '', japanese).decision, 'pass');
});

test('human の日本語だけでも日本語を期待する', () => assert.equal(judgeResponseLanguage(longEnglish, '結果を教えてください。', { settings: {} }).decision, 'block'));

test('mode は off/warn/block を選べ、既定は block', () => {
  assert.equal(judgeResponseLanguage(longEnglish, '', { ...japanese, mode: 'off' }).decision, 'pass');
  assert.equal(judgeResponseLanguage(longEnglish, '', { ...japanese, mode: 'warn' }).decision, 'warn');
  assert.equal(judgeResponseLanguage(longEnglish, '', japanese).decision, 'block');
});
