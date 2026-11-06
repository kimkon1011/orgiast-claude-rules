import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { collectSessions, runSweep, waitingReason } from './morning-session-sweep.mjs';
function fixture(t) {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'morning-sweep-'));
  t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const dir=path.join(home,'.claude','projects','p'); fs.mkdirSync(dir,{recursive:true});
  function put(id,title,answer,age=0,sub='') {
    const file=path.join(dir,sub,id+'.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});
    const rows=[{type:'custom-title',customTitle:title},{type:'user',message:{role:'user',content:'最初の依頼'}},{type:'user',message:{role:'user',content:'最後の依頼'}},{type:'assistant',message:{role:'assistant',content:answer}}];
    fs.writeFileSync(file,rows.map(r=>JSON.stringify(r)).join('\n')+'\ncorrupt line\n');
    const time=new Date(Date.now()-age*86400000);fs.utimesSync(file,time,time);
    return file;
  }
  return {home,put};
}
test('recent unclosed sessions only, latest prompt/title/deadline and three wait reasons',async t=>{
  const f=fixture(t);f.put('kim','案件A【11/06/09:30まで】','kim 待ち');f.put('external','案件B','先方の返信待ち');f.put('working','案件C','作業中');f.put('old','古い','作業中',8);f.put('closed','終了','作業中');f.put('titleclosed','終了【閉じて可】','完了');f.put('agent-1','子','作業中',0,'subagents');
  fs.writeFileSync(path.join(f.home,'.claude','closed-sessions.json'),JSON.stringify({ids:['closed']}));
  const sessions=await collectSessions({home:f.home}); assert.equal(sessions.length,3);
  const a=sessions.find(s=>s.sessionId==='kim');assert.equal(a.deadline,'11/06/09:30');assert.equal(a.request,'最後の依頼');assert.equal(a.reason,'kim 待ち');
  assert.equal(sessions.find(s=>s.sessionId==='external').reason,'外部待ち');assert.equal(sessions.find(s=>s.sessionId==='working').reason,'作業途中');
});
test('existing inbox/fleet route, PC label and daily dedupe; dry run does not publish',async t=>{
  const f=fixture(t);f.put('a','案件A','作業中');const calls=[];const post=async(...args)=>{calls.push(args);return {};};
  await runSweep({home:f.home,label:'営業PC-2',post,dryRun:true});assert.equal(calls.length,0);
  const r=await runSweep({home:f.home,label:'営業PC-2',post});assert.equal(calls.length,1);assert.match(calls[0][1].dedupeKey,/morning-session-sweep:営業PC-2:/);assert.match(r.text,/営業PC-2.*未クローズ 1件/);assert.equal(calls[0][1].source,'morning-session-sweep');
  await assert.rejects(runSweep({home:f.home,label:'PC-2',post:async()=>({forwardError:'offline'})}),/未完了/);
});
test('latest human request overrides old waiting text',()=>assert.equal(waitingReason('案件','kim 待ち','user'),'作業途中'));
