import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DESKTOP_CHATS, desktopProblems } from './line-desktop-health.mjs';
import { runHealth } from './line-share-health.mjs';
const now = Date.parse('2026-10-25T12:00:00Z'), hour=3600_000;
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
