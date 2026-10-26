import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DESKTOP_CHATS, desktopProblems, desktopStartupProblems, desktopDailyReport } from './line-desktop-health.mjs';
import { runHealth, getDesktopTask, recoverDesktopTask } from './line-share-health.mjs';
const now = new Date(2026, 9, 25, 12).getTime(), hour=3600_000;
const success = (age=0) => ({ startedAt:new Date(now-age*hour).toISOString(), finishedAt:new Date(now-age*hour).toISOString(), status:'completed', chats:DESKTOP_CHATS.map(chat => ({chat,status:'imported'})) });
test('36h PC clock independent of mobile; missing, partial, future, boundary', () => {
 assert.deepEqual(desktopProblems({runs:[success(36)],now}),[]);
 assert.equal(desktopProblems({runs:[success(36.01)],now})[0].key,'desktop-stale');
 for(const runs of [[],[success(-1)],[{...success(),status:'partial'}],[{...success(),chats:success().chats.slice(1)}]]) assert.equal(desktopProblems({runs,now})[0].key,'desktop-stale');
 const r=desktopProblems({runs:[success(40),{startedAt:new Date(now).toISOString(),reason:'user-active'}],attempts:[{at:new Date(now).toISOString(),reason:'skip:line-locked'}],now});
 assert.match(r[0].detail,/user-active 1回 \/ line-locked 1回/);
});
test('empty and ratio spike include specimen; seven same-chat imports baseline; each import checked even if a later retry succeeds',()=>{
 const event=(i,unresolved=10)=>({ts:now-10+i,source:'desktop',kind:'export-stored',chat:'test',messages:90,unresolvedSender:unresolved,specimenPath:'inbox/processed/sample.txt'});
 const baseline=Array.from({length:7},(_,i)=>event(i));
 const check=events=>desktopProblems({runs:[success()],events,now});
 assert.deepEqual(check(baseline),[]);
 assert.equal(check([...baseline,event(8,90)])[0].key,'desktop-format:test');
 assert.deepEqual(check([...baseline,event(8,30)]),[]);
 assert.deepEqual(check([event(8,90)]),[]);
 assert.equal(check([...baseline,event(8,90),event(9)])[0].key,'desktop-format:test');
 const empty={...event(9),kind:'export-empty',messages:0,stats:{dateLinesFound:2},specimenPath:'inbox/rejected/sample.txt'};
 assert.match(check([empty])[0].detail,/inbox\/rejected\/sample.txt/);
 assert.deepEqual(check([{...empty,source:'mobile'}]),[]);
 assert.deepEqual(check([{...empty,ts:now-37*hour}]),[]);
});
const healthy=async url=>{const u=new URL(url);return u.pathname==='/manifest.json'?Response.json({share_target:{}}):u.search?Response.json({ok:true,probe:'line-share-health-v1'}):new Response(null,{status:303,headers:{location:'/?share_error=auth'}});};
test('real JSONL, mobile freshness cannot hide PC; kick and DM cooldown; dry-run no writes',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-health-'));
 try {
  let kicks=0,dms=0;
  const opts={base:'https://example.test',token:'test',now,fetchImpl:healthy,stateFile:path.join(dir,'state'),debugFile:path.join(dir,'debug'),desktopRunsFile:path.join(dir,'runs'),desktopAttemptsFile:path.join(dir,'attempts'),kickDesktop:async()=>{kicks++;},sendDm:async()=>{dms++;}};
  fs.writeFileSync(opts.debugFile,JSON.stringify({kind:'export-stored',source:'mobile',ts:now}));
  fs.writeFileSync(opts.desktopRunsFile,'broken\n'+JSON.stringify(success(40)));
  const dry=await runHealth({...opts,dryRun:true});
  assert.equal(dry.problems[0].key,'desktop-stale');assert.equal(kicks,0);assert.equal(dms,0);assert.equal(fs.existsSync(opts.stateFile),false);
  await runHealth(opts);await runHealth({...opts,now:now+hour});assert.equal(kicks,1);assert.equal(dms,1);
  await runHealth({...opts,now:now+6*hour});assert.equal(kicks,2);assert.equal(dms,2);
  fs.writeFileSync(opts.desktopRunsFile,JSON.stringify(success()));
  assert.deepEqual((await runHealth(opts)).problems,[]);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('failed kick recorded; failed DM retried without duplicate kick',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'desktop-health-'));
 try{
  let kicks=0;
  const opts={base:'https://example.test',token:'test',now,fetchImpl:healthy,stateFile:path.join(dir,'state'),debugFile:path.join(dir,'debug'),desktopRunsFile:path.join(dir,'runs'),desktopAttemptsFile:path.join(dir,'attempts'),kickDesktop:async()=>{kicks++;throw new Error('task failed');},sendDm:async()=>{throw new Error('DM failed');}};
  await assert.rejects(runHealth(opts),/DM failed/);
  assert.equal(JSON.parse(fs.readFileSync(opts.stateFile)).desktopRecovery,'failed');
  await assert.rejects(runHealth(opts),/DM failed/);assert.equal(kicks,1);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('startup uses newer task or run timestamp, 3h boundary and local operating hours', () => {
 const task={lastRunTime:new Date(now-3*hour).toISOString(),runOnlyIfIdle:true,enabled:true,state:'Ready'};
 const check=(runs=[],t=task,n=now)=>desktopStartupProblems({runs,task:t,now:n});
 assert.equal(check()[0].key,'desktop-not-starting');
 assert.match(check()[0].detail,/RunOnlyIfIdle=true.*Enabled=true.*Ready/);
 assert.deepEqual(check([{startedAt:new Date(now-hour).toISOString()}]),[]);
 assert.deepEqual(check([],{...task,lastRunTime:new Date(now-1).toISOString()}),[]);
 assert.deepEqual(check([],{},new Date(2026,9,25,2,29).getTime()),[]);
 assert.equal(check([],{},new Date(2026,9,25,2,30).getTime()).length,1);
 assert.equal(check([],{},new Date(2026,9,25,23,59).getTime()).length,1);
 assert.equal(check([{startedAt:new Date(now+hour).toISOString()}]).length,1);
});
test('PowerShell queries task and repairs idle setting before start, errors propagate',()=>{
 let command;
 const spawn=(exe,args)=>{assert.equal(exe,'powershell.exe');command=args.at(-1);return {status:0,stdout:'{"runOnlyIfIdle":true}'};};
 assert.equal(getDesktopTask(spawn).runOnlyIfIdle,true);
 assert.match(command,/Get-ScheduledTaskInfo/);
 recoverDesktopTask(spawn);
 assert.match(command,/if\(\$t.Settings.RunOnlyIfIdle\).*RunOnlyIfIdle=\$false; Set-ScheduledTask.*Start-ScheduledTask/s);
 assert.throws(()=>recoverDesktopTask(()=>({status:1,stderr:'denied'})),/denied/);
});
test('daily breakdown counts statuses, skip reasons, chat metrics, excludes other dates/mobile/future',()=>{
 const rows=['completed','partial','skipped','failed'].map(status=>({...success(),status,reason:'user-active'}));
 rows.push(success(48));
 const e={ts:now,kind:'export-stored',source:'desktop',chat:'生成AI',stored:5,duplicates:3,unresolvedSender:2};
 const report=desktopDailyReport({runs:rows,events:[e,{...e,source:'mobile'},{...e,ts:now+1},{...e,ts:now-24*hour}],now});
 assert.match(report,/completed 1 \/ partial 1 \/ skipped 1 \/ failed 1/);
 assert.match(report,/user-active 1回/);assert.match(report,/生成AI: 新規5 \/ 重複3 \/ 未確定2/);
 assert.ok(!report.startsWith('⚠️'));assert.match(report,/毎時監視: 異常なし/);
 assert.ok(desktopDailyReport({runs:[],now}).startsWith('⚠️'));
});
test('daily report after 21 once per local day; dry-run no mutation; failed send retry',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'line-daily-'));
 try {
  const start=new Date(2026,9,25,20,59).getTime(), messages=[];
  const options={base:'https://example.test',token:'test',now:start,fetchImpl:healthy,stateFile:path.join(dir,'state'),debugFile:path.join(dir,'debug'),desktopRunsFile:path.join(dir,'runs'),sendDm:async({message})=>messages.push(message),getDesktopTask:async()=>({lastRunTime:new Date(start).toISOString()})};
  fs.writeFileSync(options.desktopRunsFile,JSON.stringify({...success(),startedAt:new Date(start).toISOString(),finishedAt:new Date(start).toISOString()}));
  fs.writeFileSync(options.debugFile,JSON.stringify({kind:'export-stored',ts:start,source:'desktop',chat:'生成AI',stored:1}));
  await runHealth(options); assert.equal(messages.length,0);
  const at21={...options,now:start+60000};
  let printed='';const before=fs.readFileSync(options.stateFile,'utf8');
  await runHealth({...at21,dryRun:true,output:s=>printed=s});assert.match(printed,/LINE日次進捗/);assert.equal(fs.readFileSync(options.stateFile,'utf8'),before);
  await assert.rejects(runHealth({...at21,sendDm:async()=>{throw Error('DM failed');}}));
  assert.equal(JSON.parse(fs.readFileSync(options.stateFile)).dailyReportDate,undefined);
  await runHealth(at21);await runHealth({...at21,now:at21.now+hour});assert.equal(messages.length,1);
  await runHealth({...at21,now:at21.now+24*hour});assert.equal(messages.filter(m=>m.includes('LINE日次進捗')).length,2);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('startup alone triggers recovery, 6h cooldown and no dry-run recovery',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'line-start-'));
 try {
  let kicks=0;const messages=[];
  const options={base:'https://example.test',token:'test',now,fetchImpl:healthy,stateFile:path.join(dir,'state'),debugFile:path.join(dir,'debug'),desktopRunsFile:path.join(dir,'runs'),getDesktopTask:async()=>({runOnlyIfIdle:true,enabled:true,state:'Ready'}),kickDesktop:async()=>{kicks++;},sendDm:async({message})=>messages.push(message)};
  fs.writeFileSync(options.desktopRunsFile,JSON.stringify(success(4)));
  fs.writeFileSync(options.debugFile,JSON.stringify({kind:'export-stored',ts:now}));
  const r=await runHealth({...options,dryRun:true,output:()=>{}});assert.deepEqual(r.problems.map(p=>p.key),['desktop-not-starting']);assert.equal(kicks,0);
  await runHealth(options);await runHealth({...options,now:now+hour});assert.equal(kicks,1);assert.equal(messages.length,1);
  await runHealth({...options,now:now+6*hour});assert.equal(kicks,2);assert.equal(messages.length,2);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
