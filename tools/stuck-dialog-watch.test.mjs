import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessHistory, findDialogs, tick, snapshot, closeDialog, main } from './stuck-dialog-watch.mjs';
import { dialogMetrics, readJson } from './lib/stuck-dialog-state.mjs';
import { main as register } from './register-stuck-dialog-task.mjs';
const now=Date.parse('2026-10-17T01:00:00Z');
const proc=(pid,ppid,seconds,name='node.exe')=>({pid,ppid,creationDate:new Date(now+seconds*1000).toISOString(),name,commandLine:`${name} task-${pid}.mjs`});
function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'dialog-test-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return home;}
const dialog=proc(30,4,0,'OpenWith.exe');
test('history captures exited candidates, four ancestor levels, bounded retention and PID reuse',()=>{
  const h=new ProcessHistory();h.update([proc(1,0,-100),proc(2,1,-90),proc(3,2,-80),proc(4,3,-70),proc(5,4,-60),proc(6,5,-4),proc(7,0,-16)],now-2000);
  h.update([dialog,proc(6,0,1)],now+2000);
  const found=h.candidates(dialog);assert.equal(found.length,1);assert.equal(found[0].pid,6);assert.deepEqual(found[0].parents.map(p=>p.pid),[5,4,3,2]);
  h.update([],now+65000);assert.equal(h.rows.size,0);
});
test('detect process dialogs and every matching top-level window without unrelated titles',()=>{
  const p=proc(10,0,-1,'wscript.exe');
  const d=findDialogs({processes:[dialog,p],windows:[{pid:10,handle:'2',title:'Windows Script Host'},{pid:10,handle:'3',title:'Runtime Error'},{pid:10,handle:'4',title:'editor'}]},['Windows Script Host','Runtime Error']);
  assert.equal(d.length,3);assert.equal(d[0].kind,'openwith.exe');
});
test('evidence precedes close, duplicate ticks/restarts count once, close failures retry, alerts survive restart',async t=>{
  const home=fixture(t),history=new ProcessHistory(),context={home,history,patterns:[]};let alerts=0,closes=0;
  const io={now:()=>now,snapshot:()=>({processes:[proc(20,1,-5),dialog],windows:[]}),runningTasks:()=>[{TaskName:'OrgiastCostImproveLoop'}],label:()=> 'PC-test',notify:async text=>{alerts++;assert.match(text,/PC-test/);return {delivered:'mock'};},close:()=>{closes++;const file=path.join(home,'.claude/logs/stuck-dialog/2026-10-17.jsonl');assert.equal(JSON.parse(fs.readFileSync(file,'utf8').split('\n')[0]).candidates[0].pid,20);throw new Error('blocked');}};
  assert.equal((await tick(context,io)).errors.length,1);
  await tick({...context,history:new ProcessHistory()},io);assert.equal(alerts,1);assert.equal(closes,2);assert.equal(dialogMetrics(home,now).stuckDialogs24h,1);
  const io2={...io,now:()=>now+7*3600000,snapshot:()=>({processes:[{...dialog,pid:31,creationDate:new Date(now+7*3600000).toISOString()}],windows:[]}),close:()=>{}};
  await tick(context,io2);assert.equal(alerts,2);assert.equal(dialogMetrics(home,now+25*3600000).stuckDialogs24h,1);
});
test('cannot save evidence => never close or notify',async t=>{
  const home=fixture(t);fs.mkdirSync(path.join(home,'.claude/logs'),{recursive:true});fs.writeFileSync(path.join(home,'.claude/logs/stuck-dialog'),'blocked');
  await assert.rejects(tick({home,history:new ProcessHistory(),patterns:[]},{now:()=>now,snapshot:()=>({processes:[dialog],windows:[]}),runningTasks:()=>[],close:()=>assert.fail('close'),notify:()=>assert.fail('notify')}));
});
test('snapshot uses one hidden, shell-free query and UTF16 preserves Japanese',()=>{
  let calls=0;
  const result=snapshot((exe,args,options)=>{calls++;assert.equal(exe,'powershell.exe');assert.equal(options.windowsHide,true);assert.equal(options.shell,false);const ps=Buffer.from(args.at(-1),'base64').toString('utf16le');assert.equal((ps.match(/Get-CimInstance Win32_Process/g)||[]).length,1);assert.match(ps,/EnumWindows/);return {status:0,stdout:JSON.stringify({lines:[`2\x1f1\x1f${new Date(now).toISOString()}\x1f100\x1fnode.exe\x1f日本語`],windows:[]})};});
  assert.equal(calls,1);assert.equal(result.processes[0].commandLine,'日本語');
});
test('close selects guarded Stop-Process or WM_CLOSE, no process tree kill',()=>{
  const scripts=[];const spawn=(exe,args,opts)=>{assert.equal(opts.windowsHide,true);scripts.push(Buffer.from(args.at(-1),'base64').toString('utf16le'));return {status:0,stdout:''};};
  closeDialog({...dialog,kind:'openwith.exe'},spawn);closeDialog({...proc(4,1,-1),kind:'title:Runtime Error',handle:'42'},spawn);
  assert.match(scripts[0],/PID reused/);assert.match(scripts[0],/Stop-Process -InputObject/);assert.match(scripts[1],/PostMessage\(\$h,0x0010/);assert.doesNotMatch(scripts[1],/Stop-Process/);
});
test('loop heartbeats on capture failure and releases lock, bounded mock time',async t=>{
  const home=fixture(t);let time=now,released=false,hb=[];
  await main(['loop','--seconds','4','--interval','2'],{home,platform:'win32',now:()=>time,acquireLock:()=>({acquired:true}),releaseLock:()=>released=true,sleep:async ms=>{time+=ms;},snapshot:()=>{throw new Error('CIM unavailable');},heartbeat:async (r,opts)=>{hb.push(r);assert.equal(opts.localOnly,true);}});
  assert.equal(hb.length,2);assert.equal(hb[0].ok,false);assert.ok(released);
});
test('registration dry-run and mock registration use hidden interactive 5-minute task',async t=>{
  const home=fixture(t),repo=path.resolve(import.meta.dirname,'..');let script='',started=false;
  const plan=await register(['--dry-run'],{home,repo});assert.equal(plan.interval,'PT5M');assert.match(plan.arguments,/loop.*290.*--interval.*2/);
  await register([],{home,repo,platform:'win32',spawnImpl:(exe,args)=>{script=args.at(-1);return {status:0,stdout:''};},start:()=>started=true});
  assert.match(script,/-LogonType Interactive/);assert.match(script,/-MultipleInstances IgnoreNew/);assert.match(script,/run-hidden.vbs/);assert.ok(started);
});

test('existing-PC ensure skips healthy watcher and repairs failed heartbeat; manifests deliver registration and runbook', async t => {
 const home=fixture(t),repo=path.resolve(import.meta.dirname,'..');
 const hb=path.join(home,'.claude/heartbeat/stuck-dialog-watch.json');fs.mkdirSync(path.dirname(hb),{recursive:true});
 fs.writeFileSync(hb,JSON.stringify({ok:true}));
 const healthy=await register(['--ensure'],{home,repo,platform:'win32',info:async()=>({state:'Ready'}),spawnImpl:()=>assert.fail('registration'),start:()=>assert.fail('start')});
 assert.equal(healthy.healthy,true);
 fs.writeFileSync(hb,JSON.stringify({ok:false}));let repaired=false;
 await register(['--ensure'],{home,repo,platform:'win32',info:async()=>({state:'Ready'}),spawnImpl:()=>({status:0,stdout:''}),start:()=>{repaired=true;}});assert.ok(repaired);
 const setup=JSON.parse(fs.readFileSync(path.join(repo,'tools/setup-manifest.json'),'utf8'));
 assert.deepEqual(setup.items.find(i=>i.id==='task:stuck-dialog-watch').repair,['register-stuck-dialog-task.mjs']);
 const dist=JSON.parse(fs.readFileSync(path.join(repo,'tools/distribution-manifest.json'),'utf8'));assert.ok(dist.dirs.includes('tools')&&dist.dirs.includes('docs'));
 assert.match(fs.readFileSync(path.join(repo,'tools/fleet-poller.ps1'),'utf8'),/if \(\$Dry\).*register-stuck-dialog-task\.mjs --ensure/);
});
