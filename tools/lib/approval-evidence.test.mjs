import test from 'node:test';
import assert from 'node:assert/strict';
import { approved, approvedAfter, readEvidence, shellSegments } from './approval-evidence.mjs';
test('explicit consent rejects negation, questions and incidental substrings', () => {
  for (const s of ['送らないで', '送信してはいけません', 'OKではない', 'OK?', 'book', 'はい、まだ待って', '送ってよいか確認して']) assert.equal(approved(s, 'mail'), false, s);
  for (const s of ['OK', 'はい', '送ってよいです。', '送信して']) assert.equal(approved(s, 'mail'), true, s);
});
test('sidechains, other sessions, tool results and later revocation cannot consent', () => {
  const a = {type:'assistant',content:'body'};
  const rows = readEvidence({session_id:'one', transcript:[a,{type:'user',content:'OK',isSidechain:true},{type:'user',content:'OK',sessionId:'two'}]});
  assert.equal(approvedAfter(rows, s => s === 'body', 'mail'), false);
  assert.equal(approvedAfter([a,{type:'user',content:[{type:'tool_result',content:'OK'}]}], () => true, 'mail'), false);
  assert.equal(approvedAfter([a,{type:'user',content:'OK'},{type:'user',content:'待って'}], () => true, 'mail'), false);
});
test('shell tokenizer preserves quoted Windows paths and separates compound commands', () => {
  assert.deepEqual(shellSegments('node "C:\\some dir\\tool.mjs" --body "a b"; rm x'), [['node','C:\\some dir\\tool.mjs','--body','a b'],['rm','x']]);
});

const consentCases = [
  ['OK', true, ['mail', 'delete']],
  ['OKです', true, ['mail', 'delete']],
  ['OK です', true, ['mail', 'delete']],
  ['全て OK です', true, ['mail', 'delete']],
  ['確認事項の1から3番は全て OK です', true, ['mail', 'delete']],
  ['はい、送ってください', true, ['mail']],
  ['送ってよい', true, ['mail']],
  ['送って大丈夫です', true, ['mail']],
  ['確認しました。送ってよいです', true, ['mail']],
  ['確認しました。送ってよい', true, ['mail']],
  ['問題ないので送って', true, ['mail']],
  ['消してOK', true, ['delete']],
  ['削除してよいです', true, ['delete']],
  ['送ってよいですか？', false, ['mail', 'delete']],
  ['まだ送らないで', false, ['mail', 'delete']],
  ['待って', false, ['mail', 'delete']],
  ['やめて', false, ['mail', 'delete']],
  ['NG', false, ['mail', 'delete']],
  ['OK? ', false, ['mail', 'delete']],
  ['OK、送らないで', false, ['mail']],
  ['OK、送信しないで', false, ['mail']],
  ['OK、消さないで', false, ['delete']],
  ['OK、削除しないで', false, ['delete']],
  ['OK、まだ送らない', false, ['mail']],
  ['OK、取り消し', false, ['mail', 'delete']],
  ['ダメ、送って', false, ['mail']],
  ['駄目、削除して', false, ['delete']],
  ['不可、送って', false, ['mail']],
  ['NG、削除して', false, ['delete']],
  ['送ってよいか', false, ['mail']],
  ['削除していいか', false, ['delete']],
];
for (const [text, expected, kinds] of consentCases) {
  for (const kind of kinds) {
    test(`approval (${kind}): ${JSON.stringify(text)} => ${expected}`, () => {
      assert.equal(approved(text, kind), expected);
    });
  }
}
