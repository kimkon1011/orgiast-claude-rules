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
