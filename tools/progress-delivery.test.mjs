import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { completionActions, extractKimActions } from './lib/auto-progress-artifact.mjs';
import { reportCheckProgress, HEARTBEAT_MS } from './lib/auto-progress-heartbeat.mjs';
import { deliverDoneInbox } from './lib/auto-progress-done-inbox.mjs';
import { checkPromise, checkPatternWarnings } from './auto-progress-check.mjs';
import { addItem, listItems, selectContext, markSeen } from './kim-inbox.mjs';
import { dispatch } from './hook-dispatch.mjs';
import { describeHook } from './hook-dispatch-registry.mjs';
function home(t) {
 const h = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-delivery-'));
 fs.mkdirSync(path.join(h, '.claude/logs'), {recursive:true});
 fs.writeFileSync(path.join(h, '.claude/cost-reporter.env'), 'REPORTER_LABEL=kim-PC');
 t.after(()=>fs.rmSync(h,{recursive:true,force:true}));return h;
}
const report = '# 結果\r\n## kim の承認待ち事項（全文）\r\n' + Array.from({length:8},(_,i)=>`${i+1}. **承認項目${i+1}**: 詳細`).join('\r\n') + '\r\n## その他\r\n1. 承認ではない';
test('DONE sibling supplies all eight approvals, replacing stale nextKim=none; same sweep saves ask and receipt', async t=>{
 const h=home(t);fs.writeFileSync(path.join(h,'.claude/logs/example-DONE.md'),report);
 const row={sessionId:'12345678-job',ts:'2026-11-01T00:00:00Z',status:'open',nextKim:'なし',check:`grep 'exit=0' 'C:/logs/scheduled-example-2026-11-01.log'`};
 assert.equal(extractKimActions(report).length,8);
 assert.equal(completionActions(row,{home:h}).kind,'ask');
 const patches=[];
 await checkPromise(row,{home:h,now:Date.parse('2026-11-01T01:00:00Z'),patch:(_,p)=>{patches.push(p);return true},io:{executeCheck:()=>({code:0,text:'達成'})}});
 const [item]=listItems(h);assert.equal(item.kind,'ask');
 for(let i=1;i<=8;i++)assert.match(item.text,new RegExp(`承認項目${i}`));
 assert.doesNotMatch(item.text,/kim がすること: なし/);
 assert.equal(patches.at(-1).doneNotifyPending,false);assert.ok(patches.at(-1).doneInboxId);
 await deliverDoneInbox(h,[row],'完了');assert.equal(listItems(h).length,1);
 const ctx=selectContext([item],{sessionId:'unrelated'});assert.match(ctx,/承認項目8/);
});
test('6-hour progress refresh keeps one record, reports errors and last log lines, and reopens seen info',async t=>{
 const h=home(t);const log=path.join(h,'job.log');fs.writeFileSync(log,'first\r\nround 2\r\nstill running\r\n');
 const row={sessionId:'heartbeat',ts:'2026-11-01T00:00:00Z',check:`grep x '${log}'`,label:'job'};
 const start=Date.parse(row.ts), result={code:1,text:'未達'},patch=(_,p)=>Object.assign(row,p);
 await reportCheckProgress(h,row,result,{now:start+HEARTBEAT_MS-1,patch});assert.equal(listItems(h).length,0);
 await reportCheckProgress(h,row,result,{now:start+HEARTBEAT_MS,patch});let [item]=listItems(h);
 assert.equal(item.priority,'high');assert.match(item.text,/still running/);markSeen(h,item.id);
 await reportCheckProgress(h,row,result,{now:start+2*HEARTBEAT_MS,patch});[item]=listItems(h);
 assert.equal(listItems(h).length,1);assert.equal(item.status,'open');assert.match(item.text,/変化なし/);
 await reportCheckProgress(h,row,{code:null,text:'timeout'},{now:start+3*HEARTBEAT_MS,patch});
 assert.match(listItems(h)[0].text,/確認エラー/);
});
test('unseen completion and approvals survive deadline and own-session saturation',async t=>{
 const h=home(t);
 for(let i=0;i<8;i++)await addItem(h,{kind:'ask',text:'old '.repeat(250)+i});
 await addItem(h,{kind:'deadline',key:'D-1',text:'期限 '.repeat(250)});
 const done=await addItem(h,{source:'auto-progress-done',text:'✅ check 達成: 他セッションの結果',dedupeKey:'complete'});
 const ask=await addItem(h,{kind:'ask',source:'auto-progress-done',text:'kim の承認待ち 8 件',dedupeKey:'approval'});
 const ctx=selectContext(listItems(h),{sessionId:'different'});assert.ok(ctx.includes(done.id));assert.ok(ctx.includes(ask.id));
});
test('real inbox worker executes during load shedding and merged output reaches prompt',async t=>{
 const h=home(t);await addItem(h,{source:'auto-progress-done',text:'✅ 完了: worker evidence',dedupeKey:'worker'});
 const hook=describeHook({command:`node "${path.resolve('tools/kim-inbox.mjs')}" --context`,timeout:5});
 assert.equal(hook.critical,true);
 const old=process.env.ORGIAST_HOME;process.env.ORGIAST_HOME=h;
 try {
  const out=await dispatch('UserPromptSubmit',JSON.stringify({hook_event_name:'UserPromptSubmit',session_id:'other'}),{home:h,overloaded:true,manifest:{events:{UserPromptSubmit:[{...hook,critical:false}]}}});
  assert.match(out.stdout,/worker evidence/);assert.equal(out.metrics.skipped,0);
 }finally{if(old===undefined)delete process.env.ORGIAST_HOME;else process.env.ORGIAST_HOME=old;}
});
test('preflight warns about dollar anchors on log regexes, including the original check',()=>{
 assert.equal(checkPatternWarnings(`node -e "process.exit(/^end .* exit=0$/m.test(require('fs').readFileSync('job.log','utf8'))?0:1)"`).length,1);
 assert.equal(checkPatternWarnings(`grep 'exit=0$' job.log`).length,1);
 assert.equal(checkPatternWarnings(`grep 'exit=0 ' job.log`).length,0);
 // JavaScript /m itself accepts CRLF; the observed extra rounds field is the actual mismatch.
 assert.ok(/^end .* exit=0$/m.test('end now exit=0\r\n'));
 assert.ok(!/^end .* exit=0$/m.test('end now exit=0 rounds=1\r\n'));
});

test('legacy info receipt is upgraded in place to ask, then stays answered on future sweeps',async t=>{
 const {refreshDoneApprovals}=await import('./lib/auto-progress-done-inbox.mjs');
 const {answerItem}=await import('./kim-inbox.mjs');
 const h=home(t),row={sessionId:'old-job',ts:'2026-11-01T00:00:00Z',status:'done',nextKim:'なし'};
 const first=await deliverDoneInbox(h,[row],'✅ 完了: old');Object.assign(row,first.receipt);
 const file=path.join(h,'done.md');fs.writeFileSync(file,report);row.doneFile=file;
 await refreshDoneApprovals(h,[row],{now:Date.now(),patch:(_,p)=>Object.assign(row,p)});
 const [item]=listItems(h);assert.equal(item.id,first.id);assert.equal(item.kind,'ask');assert.match(item.text,/承認項目8/);
 answerItem(h,item.id,'確認済み');await refreshDoneApprovals(h,[row],{now:Date.now(),patch:()=>true});
 assert.equal(listItems(h).length,1);assert.equal(listItems(h)[0].status,'answered');
});
test('progress delivery failure does not advance the six hour clock',async t=>{
 const h=home(t),row={sessionId:'retry',ts:'2026-11-01T00:00:00Z'}, now=Date.parse(row.ts)+HEARTBEAT_MS;
 const patch=()=>assert.fail('no receipt');
 await assert.rejects(reportCheckProgress(h,row,{code:1},{now,patch,io:{addKimInboxItem:()=>{throw new Error('disk full')}}}),/disk full/);
 assert.equal(row.progressNotifiedAt,undefined);
});
test('completed inbox stdout survives worker timeout after rendering',async t=>{
 const h=home(t),file=path.join(h,'kim-inbox.mjs');
 fs.writeFileSync(file,`export async function hookMain() { console.log(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'saved notice'}})); await new Promise(r=>setTimeout(r,10000)); }`);
 const hook=describeHook({command:`node "${file}"`,timeout:2});
 const result=await dispatch('UserPromptSubmit','{}',{home:h,overloaded:true,manifest:{events:{UserPromptSubmit:[hook]}}});
 assert.match(result.stdout,/saved notice/);assert.equal(result.metrics.timedOut,1);
});
test('explicit relative DONE path is resolved against registration cwd',async t=>{
 const {addCheck}=await import('./auto-progress.mjs');
 const h=home(t);fs.writeFileSync(path.join(h,'result.md'),report);
 const row=addCheck({home:h,cwd:h,session:'explicit',check:'exit 1',label:'job',deadline:'+24h',doneFile:'result.md'});
 assert.equal(completionActions(row,{home:h}).actions.length,8);
});
test('scheduled check emits heartbeat without starting a job when its condition is unmet',async t=>{
 const {addCheck}=await import('./auto-progress.mjs');const {run}=await import('./auto-progress-watch.mjs');
 const h=home(t),at=Date.parse('2026-11-01T00:00:00Z');
 addCheck({home:h,cwd:h,session:'scheduled-heartbeat',startWhen:'exit 1',label:'scheduled job',deadline:'+24h',nextClaude:'start after arrival',now:at});
 await run({home:h,now:at+HEARTBEAT_MS,io:{clock:()=>at+HEARTBEAT_MS,sheetConfig:()=>null,digest:async()=>({}),executeCheck:()=>({code:1,text:'not arrived'}),resume:()=>assert.fail('not ready')}});
 const [item]=listItems(h);assert.equal(item.source,'auto-progress-heartbeat');assert.match(item.text,/not arrived/);
});
test('heartbeat refresh forwards its new body again on a non-kim PC',async t=>{
 const h=home(t);fs.writeFileSync(path.join(h,'.claude/cost-reporter.env'),'REPORTER_LABEL=other-PC');
 fs.writeFileSync(path.join(h,'.claude/fleet-pc-map.json'),JSON.stringify({'other-PC':{account:'other@example.test'}}));
 let calls=0;const execImpl=async(_file,args)=>{calls++;assert.match(args[args.indexOf('--why')+1],/source:auto-progress-heartbeat/);return {stdout:`mail-refresh-${calls}`}};
 const options={kind:'info',source:'auto-progress-heartbeat',priority:'high',dedupeKey:'heartbeat:remote',refresh:true,execImpl};
 const first=await addItem(h,{...options,text:'途中経過: 1'});const second=await addItem(h,{...options,text:'途中経過: 変化なし'});
 assert.equal(first.id,second.id);assert.equal(calls,2);assert.equal(second.status,'forwarded');
});
test('redaction never collapses different heartbeat job identities',async t=>{
 const h=home(t),ts='2026-11-01T00:00:00Z',now=Date.parse(ts)+HEARTBEAT_MS;
 for(const sessionId of ['job-a','job-b'])await reportCheckProgress(h,{sessionId,ts},{code:1,text:'same'},{now,patch:()=>true});
 const items=listItems(h);assert.equal(items.length,2);assert.notEqual(items[0].dedupeKey,items[1].dedupeKey);
 assert.ok(items.every(i=>!i.dedupeKey.includes('REDACTED')));
});
test('forwarded heartbeat metadata updates one remote item and retains priority context',async t=>{
 const {ingestFleetMail}=await import('./kim-inbox.mjs');const h=home(t),dir=path.join(h,'.claude/fleet-inbox');fs.mkdirSync(dir);
 for(let i=1;i<=2;i++) {
  const id=`mail-heartbeat-${i}`;fs.writeFileSync(path.join(dir,id+'.json'),JSON.stringify({id,from:'other-PC',why:'[kim-inbox:info] [source:auto-progress-heartbeat] [key:heartbeat:job]',body:`途中経過: ${i}`,status:'new'}));
  await ingestFleetMail(h);
 }
 const items=listItems(h);assert.equal(items.length,1);assert.equal(items[0].text,'途中経過: 2');
 assert.equal(items[0].source,'auto-progress-heartbeat');assert.match(selectContext(items,{sessionId:'any'}),/途中経過: 2/);
});
