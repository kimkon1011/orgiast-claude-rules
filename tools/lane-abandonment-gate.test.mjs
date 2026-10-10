import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateLaneAbandonment, failureSignal } from './lane-abandonment-gate.mjs';
function use(name,input={},id='next') { return {type:'tool_use',name,input,id}; }
function result(content,id='fail') { return {type:'tool_result',content,tool_use_id:id}; }
export function transcript(blocks,model='claude-opus-5') { return [JSON.stringify({type:'user',message:{role:'user',content:'実装して'}}), ...blocks.map(b=>JSON.stringify({type:b.type==='tool_result'?'user':'assistant',message:{role:b.type==='tool_result'?'user':'assistant',model:b.type==='tool_result'?undefined:model,content:[b]}}))].join('\n'); }
const repair = '[LANE-REPAIR] codex: 修復済み wsl --install で Ubuntu を導入し codex-do で実測 OK';
function evaluate(t,blocks,opts={}) { const home=fs.mkdtempSync(path.join(os.tmpdir(),'lane-gate-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const r=evaluateLaneAbandonment({transcriptRaw:transcript(blocks,opts.model),assistantText:opts.text||'完了',sessionId:'s'},{home});assert.equal(fs.readFileSync(path.join(home,'.claude/course-corrections-ledger.jsonl'),'utf8').trim().split('\n').length,1);return r; }
const failure=[use('Bash',{command:'node tools/codex-do.mjs task'},'fail'),result('exit code 1')];
for (const name of ['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Agent', 'mcp__example__read']) {
  test(`${name}: quoted lane failures produce no signals and pass`, t => {
    const r = evaluate(t, [use(name, {}, 'quoted'), result('HTTP 402「prepayment credits are depleted」\nWSL ディストリが見つかりません', 'quoted'), use('Edit', {file_path:'a.js'})]);
    assert.deepEqual(r.signals, []);
    assert.equal(r.decision, 'pass');
  });
}
test('unmatched tool_result produces no signals and passes', t => {
  const r = evaluate(t, [result('prepayment credits are depleted\nWSL ディストリが見つかりません'), use('Edit', {file_path:'a.js'})]);
  assert.deepEqual(r.signals, []);
  assert.equal(r.decision, 'pass');
});
for (const name of ['Bash', 'PowerShell']) {
  test(`${name}: codex-do lane failures still produce signals and block`, t => {
    for (const text of ['HTTP 402「prepayment credits are depleted」', 'WSL ディストリが見つかりません']) {
      const input = name === 'Bash' ? {command:'node tools/codex-do.mjs task'} : {script:'node tools/codex-do.mjs task'};
      const r = evaluate(t, [use(name, input, 'fail'), result(text)]);
      assert.equal(r.signals.length, 1);
      assert.equal(r.decision, 'block');
    }
  });
}
test('codex nonzero followed by code Edit blocks',t=>assert.equal(evaluate(t,[...failure,use('Edit',{file_path:'/repo/a.js'})]).decision,'block'));
test('all providers failed followed by three shell calls blocks',t=>assert.equal(evaluate(t,[use('Bash',{command:'node llm-ask.mjs'},'fail'),result('全候補が失敗'),...Array.from({length:3},()=>use('Bash',{command:'npm test'}))]).decision,'block'));
test('doctor after failure exempts',t=>assert.equal(evaluate(t,[...failure,use('Bash',{command:'node tools/lane-doctor.mjs --probe'}),use('Write',{file_path:'a.js'})],{text:repair}).decision,'pass'));
test('fallback with reason exempts',t=>assert.equal(evaluate(t,[...failure,use('Edit',{file_path:'a.js'})],{text:'[LANE-FALLBACK] 全レーン停止を確認しSonnetへ委譲\n[LANE-REPAIR] codex: 修復不可 試行: 再インストールが拒否された'}).decision,'pass'));
test('sonnet session passes',t=>assert.equal(evaluate(t,[...failure,use('Edit',{file_path:'a.js'})],{model:'claude-sonnet-5'}).decision,'pass'));
test('doctor before failure does not exempt',t=>assert.equal(evaluate(t,[use('Bash',{command:'node tools/lane-doctor.mjs --probe'}),...failure,use('Edit',{file_path:'a.js'})]).decision,'block'));
test('line numbers and zero exit are not failures',()=>{assert.equal(failureSignal('HTTP source.ts:429:12'), '');assert.equal(failureSignal('exit code 0','codex-do.mjs'), '');});
test('documentation edits and pre-failure edits do not count',t=>assert.equal(evaluate(t,[use('Edit',{file_path:'a.js'}),...failure,use('Edit',{file_path:'note.md'})],{text:repair}).decision,'pass'));
test('prior turn and quoted user failures are excluded',t=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),'lane-turn-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const raw=transcript([...failure,use('Edit',{file_path:'a.js'})])+'\n'+JSON.stringify({type:'user',message:{role:'user',content:'引用: HTTP 429 / 全候補が失敗'}})+'\n'+JSON.stringify({type:'assistant',message:{model:'claude-opus-5',content:[use('Edit',{file_path:'a.js'})]}});assert.equal(evaluateLaneAbandonment({transcriptRaw:raw,assistantText:'完了'},{home}).decision,'pass');});

for (const name of ['Bash', 'PowerShell']) {
  const shell = command => use(name, name === 'PowerShell' ? {script:command} : {command});
  test(`${name}: five read-only calls after failure pass`, t => {
    assert.equal(evaluate(t,[...failure,...['cat a.txt','git log -1','ls tools','grep foo a.txt','head a.txt'].map(shell)],{text:repair}).decision,'pass');
  });
  test(`${name}: three writes after failure block`, t => {
    assert.equal(evaluate(t,[...failure,...['echo a > a.txt','mkdir out','cp a.txt out/'].map(shell)]).decision,'block');
  });
  test(`${name}: delegation commands do not count toward abandonment`, t => {
    assert.equal(evaluate(t,[...failure,...['codex-do','llm-ask','pr-merge'].map(tool => shell(`node tools/${tool}.mjs`)),shell('npm test'),shell('npm test')],{text:repair}).decision,'pass');
  });
}

test('WSL 不在と spawn ENOENT を失敗シグナルとして拾う',()=>{
  assert.ok(failureSignal('WSL ディストリが見つかりませんでした'));
  assert.ok(failureSignal('Error: spawn codex ENOENT'));
});
test('command not found は委譲コマンドだけを拾う',()=>{
  for (const command of ['node tools/codex-do.mjs', 'node tools/cheap-code.mjs', 'node tools/llm-ask.mjs', 'gemini', 'qwen']) {
    assert.ok(failureSignal('command not found',command));
    assert.ok(failureSignal('is not recognized as an internal or external command',command));
  }
  assert.equal(failureSignal('command not found','unrelated'), '');
});
test('失敗後に修理報告がなければ LANE-UNREPAIRED',t=>{
  const r=evaluate(t,failure);assert.equal(r.decision,'block');assert.equal(r.code,'LANE-UNREPAIRED');
});
test('修復済みの説明があれば実装なしのターンは pass',t=>assert.equal(evaluate(t,failure,{text:repair}).decision,'pass'));
test('修復不可は空でない試行が必須',t=>{
  for (const text of ['[LANE-REPAIR] codex: 修復不可','[LANE-REPAIR] codex: 修復不可 試行:   ','[LANE-REPAIR] codex: 修復済み   ']) assert.equal(evaluate(t,failure,{text}).decision,'block');
  assert.equal(evaluate(t,failure,{text:'[LANE-REPAIR] codex: 修復不可 試行: wsl --install が管理者権限で拒否'}).decision,'pass');
});
test('LANE-FALLBACK だけでは免除しない',t=>assert.equal(evaluate(t,failure,{text:'[LANE-FALLBACK] 全滅'}).decision,'block'));
test('失敗シグナルなしは従来どおり pass',t=>assert.equal(evaluate(t,[use('Edit',{file_path:'a.js'})]).decision,'pass'));
test('LANE-ABANDON を優先し修理報告の要求を追記する',t=>{
  const r=evaluate(t,[...failure,use('Edit',{file_path:'a.js'})]);assert.equal(r.code,'LANE-ABANDON');assert.match(r.reason,/LANE-REPAIR/);
});
test('doctor だけでは修理報告を免除しない',t=>assert.equal(evaluate(t,[...failure,use('Bash',{command:'node tools/lane-doctor.mjs --probe'})]).code,'LANE-UNREPAIRED'));
test('user の LANE-OK 免除を維持する',t=>{
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'lane-ok-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const raw=transcript(failure).replace('実装して','[LANE-OK] 実装して');
  assert.equal(evaluateLaneAbandonment({transcriptRaw:raw,assistantText:'完了'},{home}).decision,'pass');
});

test('修理報告だけでは失敗後の本体実装を免除しない',t=>{
  const r=evaluate(t,[...failure,use('Edit',{file_path:'a.js'})],{text:repair});
  assert.equal(r.decision,'block');assert.equal(r.code,'LANE-ABANDON');
});
