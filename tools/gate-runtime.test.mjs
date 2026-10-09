import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rolloutMode, applyGatePolicy, remedyStatus, reportGate } from './gate-runtime.mjs';
import { runHook, wrapRegisteredGates } from './gate-hook-runner.mjs';
import { repoDir, toolsDir } from './gate-contracts.mjs';
const DAY=86400000;
const start=Date.parse('2026-10-09T00:00:00Z');
const contract={name:'new-gate',remedies:[{kind:'keyserve-key',ref:'example.env#KEY'}]};
function temp(t){const h=fs.mkdtempSync(path.join(os.tmpdir(),'gate-runtime-'));t.after(()=>fs.rmSync(h,{recursive:true,force:true}));return h;}
const manifest={pilotHosts:['kim-PC'],gates:{'new-gate':{rollout:'deny',distributedAt:new Date(start).toISOString(),denyAfter:new Date(start+7*DAY).toISOString()},old:{rollout:'deny',legacy:true}}};
test('rollout covers pilot, seven day boundary, late arrivals, missing manifest and legacy',t=>{
 const home=temp(t),opts={home,manifest,hostname:'member',now:start};
 assert.equal(rolloutMode('old',opts),'deny');
 assert.equal(rolloutMode('new-gate',{...opts,hostname:'kim-PC'}),'deny');
 assert.equal(rolloutMode('new-gate',opts),'warn');
 assert.equal(rolloutMode('new-gate',{...opts,now:start+7*DAY-1}),'warn');
 assert.equal(rolloutMode('new-gate',{...opts,now:start+7*DAY}),'deny');
 assert.equal(rolloutMode('new-gate',{...opts,home:temp(t),now:start+30*DAY}),'warn');
 assert.equal(rolloutMode('unknown',opts),'warn');
 assert.equal(rolloutMode('new-gate',{...opts,manifest:{gates:{'new-gate':{rollout:'deny',distributedAt:'bad',denyAfter:'bad'}}},now:start+90*DAY}),'warn');
});
test('a declared key is fetched once, merged, rechecked, and actual success passes',async t=>{
 const home=temp(t); let refreshes=0,retries=0,notices=0;
 const value=await applyGatePolicy(contract,{decision:'block',reason:'missing'}, {home,manifest,now:start,hostname:'member',refresh:async()=>{refreshes++;fs.mkdirSync(path.join(home,'.claude'),{recursive:true});fs.writeFileSync(path.join(home,'.claude/example.env'),'KEY=private-value\n');},retry:()=>{retries++;return {decision:'pass'};},notify:async()=>{notices++;return {delivered:'dm'};}});
 assert.equal(value.decision,'pass');assert.equal(refreshes,1);assert.equal(retries,1);assert.equal(notices,0);
});
test('fetch failure retains denial on legacy gates and reports only key names/status',async t=>{
 const home=temp(t);let count=0,line='';
 const c={...contract,name:'old'};
 const value=await applyGatePolicy(c,{decision:'block',reason:'secret-url-must-not-be-reported'}, {home,manifest,refresh:async()=>{count++;throw Error('private');},notify:async s=>{line=s;return {delivered:'dm'};}});
 assert.equal(value.decision,'block');assert.equal(count,1);assert.match(value.reason,/onboarding-sync/);assert.match(line,/example.env#KEY:missing/);assert.doesNotMatch(line,/private|secret-url/);
});
test('retrieval alone does not bypass missing application setup',async t=>{
 const home=temp(t);let retries=0;
 const value=await applyGatePolicy({...contract,name:'old'},{decision:'block',reason:'form absent'}, {home,manifest,refresh:async()=>{},retry:()=>{retries++;return {decision:'block',reason:'install form'};},notify:async()=>({delivered:'dm'})});
 assert.equal(retries,1);assert.equal(value.decision,'block');assert.match(value.reason,/install form/);
});
test('report deduplication is atomic per PC/gate/day, values never transmitted',async t=>{
 const home=temp(t);let calls=0;const opts={home,hostname:'member',now:start,notify:async line=>{calls++;assert.equal(line.split('\n').length,1);return {delivered:'dm'};}};
 await Promise.all(Array.from({length:8},()=>reportGate(contract,'warn',remedyStatus(contract,{home}),opts)));
 assert.equal(calls,1);
 await reportGate(contract,'deny',[],{...opts,now:start+DAY});assert.equal(calls,2);
 await reportGate(contract,'warn',[],{...opts,hostname:'other'});assert.equal(calls,3);
});
test('new and existing registration migrate to wrapper idempotently, unrelated hooks preserved',t=>{
 for(const existing of [false,true]) {
  const home=temp(t),file=path.join(home,'.claude/settings.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  if(existing) fs.writeFileSync(file,JSON.stringify({hooks:{PreToolUse:[{matcher:'Bash|PowerShell',hooks:[{type:'command',command:'node "C:/old/tools/feedback-form-gate.mjs"',timeout:10}]}]}}));
  const run=()=>spawnSync(process.execPath,[path.join(toolsDir,'register-hooks.mjs'),'--hooks-only'],{env:{...process.env,ORGIAST_HOME:home,ORGIAST_REPO:repoDir},encoding:'utf8'});
  assert.equal(run().status,0);const before=fs.readFileSync(file,'utf8');assert.equal(run().status,0);assert.equal(fs.readFileSync(file,'utf8'),before);
  const settings=JSON.parse(before);const hook=settings.hooks.PreToolUse.flatMap(g=>g.hooks).find(h=>h.command.includes('feedback-form-gate.mjs'));
  assert.match(hook.command,/gate-hook-runner\.mjs/);assert.ok(hook.command.includes(toolsDir));
 }
 const custom={hooks:{Stop:[{hooks:[{type:'command',command:'node "/unrelated/custom.mjs"'}]}]}};
 assert.equal(wrapRegisteredGates(custom,repoDir),0);
});
test('wrapper converts both PreToolUse and Stop blocks to visible warnings',async t=>{
 const home=temp(t),file=path.join(home,'new-gate.mjs');
 for(const pre of [true,false]) {
  const output=pre?{hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'why'}}:{decision:'block',reason:'why'};
  fs.writeFileSync(file,`export const GATE_CONTRACT = ${JSON.stringify({name:'new-gate',remedies:[{kind:'command',ref:'node --version'}]})};\nconsole.log(${JSON.stringify(JSON.stringify(output))});\n`);
  const out=await runHook(file,JSON.stringify({hook_event_name:pre?'PreToolUse':'Stop'}),{env:{...process.env,ORGIAST_HOME:home},policyOptions:{home,manifest,now:start,hostname:'member',notify:async()=>({delivered:'dm'})}});
  const parsed=JSON.parse(out.stdout);assert.equal(out.status,0);assert.notEqual(parsed.decision,'block');assert.notEqual(parsed.hookSpecificOutput?.permissionDecision,'deny');assert.match(pre?parsed.hookSpecificOutput.additionalContext:parsed.systemMessage,/why/);
 }
});

test('real wrapper retries SessionStart key client once, preserves env keys, and then passes',async t=>{
 const {createServer}=await import('node:http');const {spawn}=await import('node:child_process');
 const home=temp(t);fs.mkdirSync(path.join(home,'.claude'),{recursive:true});
 fs.writeFileSync(path.join(home,'.claude/example.env'),'LOCAL_ONLY=keep\n');
 let requests=0;
 const server=createServer((req,res)=>{requests++;assert.equal(req.method,'POST');res.setHeader('content-type','application/json');res.end(JSON.stringify({files:{'example.env':'KEY=mock-value\n'}}));});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
 const file=path.join(home,'key-required.mjs');
 fs.writeFileSync(file,`export const GATE_CONTRACT = ${JSON.stringify(contract)};\nimport fs from 'node:fs';\nconst body=fs.readFileSync(process.env.ORGIAST_HOME+'/.claude/example.env','utf8');\nif(!body.includes('KEY=')) console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'PreToolUse',permissionDecision:'deny',permissionDecisionReason:'key missing'}}));\n`);
 const result=await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,[path.join(toolsDir,'gate-hook-runner.mjs'),file],{env:{...process.env,ORGIAST_HOME:home,ORGIAST_KEYSERVE_URL:`http://127.0.0.1:${server.address().port}`,ORGIAST_KEYSERVE_SECRET:'test-secret'},stdio:['pipe','pipe','pipe']});
  let out='',err='';child.stdout.on('data',c=>out+=c);child.stderr.on('data',c=>err+=c);child.on('error',reject);child.on('close',status=>resolve({status,out,err}));child.stdin.end(JSON.stringify({hook_event_name:'PreToolUse',tool_name:'Bash'}));
 });
 assert.equal(result.status,0,result.err);assert.equal(requests,1);assert.equal(result.out,'');assert.doesNotMatch(result.err,/mock-value|test-secret/);
 assert.match(fs.readFileSync(path.join(home,'.claude/example.env'),'utf8'),/LOCAL_ONLY=keep\nKEY=mock-value/);
});
test('fleet notification uses the already distributed cost webhook without a DM token',async t=>{
 const {notifyKim}=await import('./notify-kim.mjs');const home=temp(t);fs.mkdirSync(path.join(home,'.claude'),{recursive:true});fs.writeFileSync(path.join(home,'.claude/cost-reporter.env'),'DISCORD_COST_WEBHOOK=https://example.invalid/mock-only\n');
 let sent=0;const result=await notifyKim('gate status',{home,userId:'',token:'',fleetFallback:true,fetchImpl:async(url,options)=>{sent++;assert.equal(url,'https://example.invalid/mock-only');assert.equal(JSON.parse(options.body).content,'gate status');return {ok:true};}});
 assert.equal(sent,1);assert.equal(result.delivered,'webhook');
});
