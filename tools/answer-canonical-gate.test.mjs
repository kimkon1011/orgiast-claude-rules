import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeAnswerCanonical } from './answer-canonical-gate.mjs';

const answer = '提出目的などをまとめた専用ページは現在ありません。お手数ですが、以下の文面で山元さんへ直接ご回答ください。';
const blocked = [
  answer,
  `${answer}\n[CANON-OK]`, `${answer}\n[CANON-OK]   `,
  `${answer}\n[CANON-OK]\n理由は次の行`,
  `${answer}\n正本化:   `,
  `${answer}\n> 正本化: FAQ`,
  `${answer}\n\`\`\`\n[CANON-OK] 個別事情\n\`\`\``,
  `${answer}\n> [CANON-OK] 個別事情`,
  `${answer}\n~~~\n正本化: FAQ\n~~~`,
  '【kim 確認用の全文】\nマニュアルに記載がありません。',
  '返信案: 規定はないため、確認してください。',
  '回答案\n保管期間は決まっていません。',
  '資料が見つかりません。\n個別に返信してください。',
];
for (const text of blocked) test(`block: ${JSON.stringify(text)}`, () => {
  const result = judgeAnswerCanonical(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'ANSWER-CANONICAL');
  assert.match(result.reason, /正本化: <追記先の名前とリンク>/);
});

const passed = [
  `${answer}\n正本化: 応募者向けFAQ（Google ドキュメント）https://docs.google.com/...`,
  `${answer}\r\n  正本化： FAQ https://example.com/faq`,
  `${answer}\n[CANON-OK] 本人の個別事情への回答のため`,
  '> 専用ページはありません。直接ご回答ください',
  `\`\`\`text\n${answer}\n\`\`\``, `~~~text\n${answer}\n~~~`,
  `\`\`\`\`text\n\`\`\`\n${answer}\n\`\`\`\``,
  `\`\`\`\n${answer}`, `    ${answer}`, `\t${answer}`,
  'テストは全件通りました', '', undefined,
  '専用ページはありません。', '直接ご回答ください。',
  '返信案: 保管期間を説明します。', '規定がありません。',
  '専用ページはありません。\n> 直接ご回答ください。',
  '【kim 確認用の全文】\n> マニュアルに記載がありません。',
  '回答案: 決まっていない項目です。\n正本化: 社内FAQ',
];
for (const text of passed) test(`pass: ${JSON.stringify(text)}`, () => {
  assert.equal(judgeAnswerCanonical(text).decision, 'pass');
});

test('環境変数0で停止できる', t => {
  const previous = process.env.ORGIAST_ANSWER_CANONICAL_GATE;
  t.after(() => {
    if (previous === undefined) delete process.env.ORGIAST_ANSWER_CANONICAL_GATE;
    else process.env.ORGIAST_ANSWER_CANONICAL_GATE = previous;
  });
  process.env.ORGIAST_ANSWER_CANONICAL_GATE = '0';
  assert.equal(judgeAnswerCanonical(answer).decision, 'pass');
});
