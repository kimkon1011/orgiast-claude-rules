import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evaluateLaneAbandonment, failureSignal } from './lane-abandonment-gate.mjs';
function use(name,input={},id='next') { return {type:'tool_use',name,input,id}; }
function result(content,id='fail') { return {type:'tool_result',content,tool_use_id:id}; }
export function transcript(blocks,model='claude-opus-5') { return [JSON.stringify({type:'user',message:{role:'user',content:'実装して'}}), ...blocks.map(b=>JSON.stringify({type:b.type==='tool_result'?'user':'assistant',message:{role:b.type==='tool_result'?'user':'assistant',model:b.type==='tool_result'?undefined:model,content:[b]}}))].join('\n'); }
function evaluate(t,blocks,opts={}) { const home=fs.mkdtempSync(path.join(os.tmpdir(),'lane-gate-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const r=evaluateLaneAbandonment({transcriptRaw:transcript(blocks,opts.model),assistantText:opts.text||'完了',sessionId:'s'},{home});assert.equal(fs.readFileSync(path.join(home,'.claude/course-corrections-ledger.jsonl'),'utf8').trim().split('\n').length,1);return r; }
const failure=[use('Bash',{command:'node tools/codex-do.mjs task'},'fail'),result('exit code 1')];
test('codex nonzero followed by code Edit blocks',t=>assert.equal(evaluate(t,[...failure,use('Edit',{file_path:'/repo/a.js'})]).decision,'block'));
test('all providers failed followed by three shell calls blocks',t=>assert.equal(evaluate(t,[use('Bash',{command:'node llm-ask.mjs'},'fail'),result('全候補が失敗'),...Array.from({length:3},()=>use('Bash',{command:'npm test'}))]).decision,'block'));
test('doctor after failure exempts',t=>assert.equal(evaluate(t,[...failure,use('Bash',{command:'node tools/lane-doctor.mjs --probe'}),use('Write',{file_path:'a.js'})]).decision,'pass'));
test('fallback with reason exempts',t=>assert.equal(evaluate(t,[...failure,use('Edit',{file_path:'a.js'})],{text:'[LANE-FALLBACK] 全レーン停止を確認しSonnetへ委譲'}).decision,'pass'));
test('sonnet session passes',t=>assert.equal(evaluate(t,[...failure,use('Edit',{file_path:'a.js'})],{model:'claude-sonnet-5'}).decision,'pass'));
test('doctor before failure does not exempt',t=>assert.equal(evaluate(t,[use('Bash',{command:'node tools/lane-doctor.mjs --probe'}),...failure,use('Edit',{file_path:'a.js'})]).decision,'block'));
test('line numbers and zero exit are not failures',()=>{assert.equal(failureSignal('HTTP source.ts:429:12'), '');assert.equal(failureSignal('exit code 0','codex-do.mjs'), '');});
test('documentation edits and pre-failure edits do not count',t=>assert.equal(evaluate(t,[use('Edit',{file_path:'a.js'}),...failure,use('Edit',{file_path:'note.md'})]).decision,'pass'));
test('prior turn and quoted user failures are excluded',t=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),'lane-turn-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const raw=transcript([...failure,use('Edit',{file_path:'a.js'})])+'\n'+JSON.stringify({type:'user',message:{role:'user',content:'引用: HTTP 429 / 全候補が失敗'}})+'\n'+JSON.stringify({type:'assistant',message:{model:'claude-opus-5',content:[use('Edit',{file_path:'a.js'})]}});assert.equal(evaluateLaneAbandonment({transcriptRaw:raw,assistantText:'完了'},{home}).decision,'pass');});
