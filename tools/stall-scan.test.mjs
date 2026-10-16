import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scan, asAnomalies, formatTable, sessionSummary, probePort } from './stall-scan.mjs';
import { writeJson } from './lib/stuck-dialog-state.mjs';
import * as watcherRepair from './lib/remediate-playbooks/stuck-dialog-watcher.mjs';
import { buildBeacon, fetchBeacons } from './fleet-beacon.mjs';
const now=Date.parse('2026-10-17T01:00:00Z');
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'stall-scan-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return home;}
function put(home,file,value){writeJson(path.join(home,'.claude',file),value);}
const opts=home=>({home,now,label:'test-PC',platform:'win32',expectations:[],taskQuery:()=>[]});
test('aggregate actual signals with no notification or registration',async t=>{
 const home=fixture(t);
 put(home,'state/stuck-dialog-watch.json',{events:[{at:now-1000,kind:'openwith.exe'}]});
 put(home,'heartbeat/stuck-dialog-watch.json',{finishedAt:new Date(now-1000).toISOString(),ok:true});
 put(home,'heartbeat/job.json',{job:'sample',finishedAt:new Date(now-3600000).toISOString(),ok:true,cycleMinutes:5});
 put(home,'provider-cooldown.json',{codex:{until:now+60000,reason:'limit'}});
 put(home,'stalled-session-resume.json',{sessions:{abc:{noProgress:2}}});
 put(home,'stall-scan-servers.json',{servers:[{name:'local',port:4321}]});
 const result=await scan({...opts(home),save:true,expectations:[{log:'missing.log',label:'job',maxAgeHours:1}],taskQuery:()=>[{taskName:'OrgiastJob',status:1,t:new Date(now-3600000).toISOString(),nextRunTime:new Date(now-1800000).toISOString(),state:'Ready',cycleMinutes:5}],probe:async()=>({listening:false,error:'ECONNREFUSED'})});
 assert.deepEqual(new Set(result.rows.map(r=>r.kind)),new Set(['stuck_dialog','heartbeat_stale','cooldown','session_stalled','log_stale','task_failed','task_missed','server_down']));
 assert.match(formatTable(result),/根拠\(実データ\)/);assert.match(formatTable(result),/4321 ECONNREFUSED/);
 assert.ok(!asAnomalies(result).some(r=>['cooldown','log_stale'].includes(r.type)));
 assert.match(sessionSummary(home,now),/停滞診断: 8件/);assert.match(sessionSummary(home,now+31*3600000),/古い結果/);
});
test('healthy empty scan is silent at SessionStart; no false failure for running/never-run future task',async t=>{
 const home=fixture(t);put(home,'heartbeat/stuck-dialog-watch.json',{finishedAt:new Date(now).toISOString(),ok:true});
 const result=await scan({...opts(home),save:true,taskQuery:()=>[{taskName:'OrgiastFresh',neverRun:true,status:267011,state:'Ready',t:'1999-01-01',nextRunTime:new Date(now+60000).toISOString()},{taskName:'OrgiastBusy',status:267009,running:true,t:new Date(now-3600000).toISOString()}]});
 assert.equal(result.rows.length,0);assert.equal(sessionSummary(home,now),'');
});
test('dead watcher, failed query and broken state remain visible; non-Windows skips GUI/task probes',async t=>{
 const home=fixture(t);put(home,'provider-cooldown.json',{});fs.writeFileSync(path.join(home,'.claude/provider-cooldown.json'),'broken');
 const result=await scan({...opts(home),taskQuery:()=>{throw new Error('access denied');}});
 assert.ok(result.rows.some(r=>r.kind==='watcher_dead'));assert.equal(result.rows.filter(r=>r.kind==='scan_error').length,2);
 const linux=await scan({...opts(home),platform:'linux',taskQuery:()=>assert.fail()});assert.ok(!linux.rows.some(r=>r.kind==='watcher_dead'));
});
test('invalid server configuration never probes external targets',async()=>{await assert.rejects(probePort({host:'example.com',port:80}),/不正/);});
test('watcher repair uses injected registration and verifies a new heartbeat',async()=>{
 assert.equal(await watcherRepair.match({type:'watcher_dead'}),true);assert.equal(await watcherRepair.match({type:'stuck_dialog'}),false);
 let registered=false;const ctx={repairDialogWatcher:()=>registered=true,verifyDialogWatcher:()=>registered};
 assert.equal((await watcherRepair.apply({},ctx)).outcome,'fixed');assert.equal(await watcherRepair.verify({},ctx),true);
});
test('beacon carries counts through existing steps accepted by deployed GAS',async t=>{
 const home=fixture(t);put(home,'heartbeat/stuck-dialog-watch.json',{finishedAt:new Date(now).toISOString(),ok:true});put(home,'state/stuck-dialog-watch.json',{events:[{at:now-1}]});
 const beacon=buildBeacon({home,label:'test',now,identity:{hostname:'test',username:'test'},pcMap:{}});
 assert.equal(beacon.stuckDialogs24h,1);assert.ok(beacon.failing.includes('stuck-dialog-watch'));
 assert.match(beacon.steps.find(s=>s.id==='stuck-dialog-watch').reason,/stuckDialogs24h=1/);
});

test('beacon receiver recovers count from existing GAS step payload', async t => {
 const home=fixture(t);fs.mkdirSync(path.join(home,'.claude'),{recursive:true});
 fs.writeFileSync(path.join(home,'.claude/fleet-sheet.env'),'FLEET_SHEET_URL=https://example.test\nFLEET_SHEET_TOKEN=test\n');
 const result=await fetchBeacons({home,fetchImpl:async()=>({ok:true,json:async()=>({ok:true,beacons:[{label:'pc',steps:JSON.stringify([{id:'stuck-dialog-watch',status:'fail',reason:'stuckDialogs24h=22; heartbeat=now'}])}]})})});
 assert.equal(result.ok,true);assert.equal(result.beacons[0].stuckDialogs24h,22);
});

test('closed sessions and cleared provider cooldowns are not reported as still stalled',async t=>{
 const home=fixture(t);put(home,'heartbeat/stuck-dialog-watch.json',{finishedAt:new Date(now).toISOString(),ok:true});
 put(home,'stalled-session-resume.json',{sessions:{closed:{noProgress:3}}});put(home,'session-closed-ledger.json',{sessions:{closed:{at:now}}});
 put(home,'provider-cooldown.json',{codex:{until:now-1}});
 const result=await scan(opts(home));assert.equal(result.rows.length,0);
});

test('corrupt dialog state does not prevent the existing fleet beacon',t=>{
 const home=fixture(t);put(home,'state/stuck-dialog-watch.json',{});fs.writeFileSync(path.join(home,'.claude/state/stuck-dialog-watch.json'),'broken');
 const beacon=buildBeacon({home,label:'test',now,identity:{},pcMap:{}});
 assert.equal(beacon.stuckDialogs24h,null);assert.equal(beacon.stuckDialogWatcherOk,false);
});
