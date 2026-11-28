import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { assertSendConsistency } from './send-consistency-check.mjs';
import { sendDraft, runCli } from './gmail-draft.mjs';
import { sendDiscordDm as realDiscordDm } from './discord-dm.mjs';
import { run as lineRun } from './line-channel.mjs';
import { main as realGroupRun } from './line-group-send.mjs';
import { beeperSend as realBeeperSend } from './beeper-send.mjs';
import { judgeLive } from './mail-send-approval-gate.mjs';
import { createBeeperAdapter as realBeeperAdapter, createDiscordAdapter } from './lib/followup-adapters.mjs';
const preSendCheck = async () => ({ ok: true, findings: [] });
const sendDiscordDm = (to, body, deps) => realDiscordDm(to, body, { preSendCheck, ...deps });
const groupRun = (args, deps) => realGroupRun(args, { preSendCheck, ...deps });
const beeperSend = (args, deps) => realBeeperSend(args, { preSendCheck, ...deps });
const createBeeperAdapter = deps => realBeeperAdapter({ preSendCheck, ...deps });
import { writeContextMarker } from './lib/send-context.mjs';
const now='2026-11-27T12:00:00+09:00';
const check = extra => input => assertSendConsistency(input,{readRecentSent:async()=>[],collect:async()=>({...input,now,draftReadAt:now,...extra})});
const blocked=check({unverified:['sentHistory']});
const pass=check({});
const cleanup=async()=>({ok:true});
const res=(data,status=200)=>new Response(JSON.stringify(data),{status});
function temp(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'send-integration-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return home;}
test('Gmail共通入口: NGでPOSTゼロ、合格後だけ送信・後始末',async t=>{
 const home=temp(t);let posts=0,cleaned=0;
 const draft={message:{threadId:'thread',payload:{mimeType:'text/plain',headers:[{name:'To',value:'a@example.com'},{name:'Subject',value:'ご案内'}],body:{data:Buffer.from('本文').toString('base64url')}}}};
 const args={id:'draft',home,draft,ledger:{domains:[],addresses:[]},getToken:async()=> 'mock-token',fetchImpl:async()=>{posts++;return res({id:'message',threadId:'thread'});},acquireDedupe:async()=>({recordSuccess(){},release(){}}),cleanup:async()=>{cleaned++;return{ok:true};}};
 await assert.rejects(sendDraft({...args,consistencyCheck:blocked}),/UNVERIFIED_sentHistory/);assert.equal(posts,0);assert.equal(cleaned,0);
 assert.equal((await sendDraft({...args,consistencyCheck:pass})).sentMessageId,'message');assert.equal(posts,1);assert.equal(cleaned,1);
});
test('Gmail --ack-consistencyでも新ゲートNGを迂回しない',async()=>{
 let sent=0,old=0;const output=[];
 const result=await runCli({argv:['--send','draft','--ack-consistency','旧検査の承認','--json'],deps:{stdout:v=>output.push(v),getToken:async()=> 'mock-token',fetchImpl:async(url)=>{if(url.endsWith('/send'))sent++;return res({message:{payload:{headers:[{name:'To',value:'a@example.com'}]}}});},consistencyCheck:blocked,inspectDraft:async()=>{old++;return{ok:true};}}});
 assert.notEqual(result,0);assert.equal(sent,0);assert.equal(old,0);
});
test('Discord: 社内自動許可でも新検査NGは送信しない',async t=>{
 let posts=0;const options={home:temp(t),token:'mock',resolve:async()=>({id:'staff',label:'社内担当'}),noCopyKim:true,noReplyFooter:true,internalOptIn:true,assertContextApproved:async()=>{},cleanup,fetchImpl:async url=>{if(url.endsWith('/messages')){posts++;return res({id:'m1'});}return res({id:'dm1'});}};
 await assert.rejects(sendDiscordDm('staff','本文',{...options,consistencyCheck:blocked}),/UNVERIFIED_sentHistory/);assert.equal(posts,0);
 await sendDiscordDm('staff','本文',{...options,consistencyCheck:pass});assert.equal(posts,1);
});
test('LINE channel/group: 検査NGならpushゼロ、成功後に後始末',async t=>{
 const home=temp(t),file=path.join(home,'body.txt');fs.writeFileSync(file,'本文');let pushes=0,cleaned=0;
 const request=async(_channel,opts)=>opts.query?{contacts:[{id:'C1',name:'group',active:true}]}:(pushes++,{ok:true,sentMessages:[{id:'m'}]});
 await assert.rejects(lineRun(['--to','C1','--body-file',file,'--send'],request,{consistencyCheck:blocked}),/UNVERIFIED_sentHistory/);assert.equal(pushes,0);
 await lineRun(['--to','C1','--body-file',file,'--send'],request,{consistencyCheck:pass,cleanup:async()=>{cleaned++;}});assert.equal(pushes,1);
 const deps={home,loadSecrets:async()=>({LINE_CHANNEL_ACCESS_TOKEN:'mock'}),resolveGroup:async()=> 'C1',assertContextApproved:async()=>{},cleanup:async()=>{cleaned++;},fetchImpl:async url=>url.endsWith('/summary')?res({groupName:'group'}):(pushes++,res({sentMessages:[{id:'m'}]}))};
 await assert.rejects(groupRun(['--group','group','--text-file',file],{...deps,consistencyCheck:blocked}),/UNVERIFIED_sentHistory/);assert.equal(pushes,1);
 await groupRun(['--group','group','--text-file',file],{...deps,consistencyCheck:pass});assert.equal(pushes,2);assert.equal(cleaned,2);
});
test('Beeper: 承認済みキューでもNGはsendゼロ、成功受付を先に記録',async t=>{
 const home=temp(t),file=path.join(home,'body.txt'),time=new Date().toISOString();fs.writeFileSync(file,'本文');
 fs.mkdirSync(path.join(home,'.claude','reply-queue'),{recursive:true});
 fs.writeFileSync(path.join(home,'.claude','reply-queue','queue.json'),JSON.stringify({version:1,items:{q1:{id:'q1',state:'approved',receivedAt:time,receipt:{id:'rc1',issuedAt:time,expiresAt:new Date(Date.now()+60000).toISOString()}}}}));
 writeContextMarker({channel:'beeper',target:'chat',text:'本文',latest:null,reason:'テスト',home});
 let sends=0,cleaned=0;const deps={readMessages:async()=>({items:[]}),send:async()=>{sends++;return{pendingMessageID:'pending1'};},cleanup:async()=>{cleaned++;},readbackMs:0};
 const options={home,chatID:'chat',bodyFile:file,queueID:'q1',receiptID:'rc1'};
 await assert.rejects(beeperSend(options,{...deps,consistencyCheck:blocked}),/UNVERIFIED_sentHistory/);assert.equal(sends,0);
 const result=await beeperSend(options,{...deps,consistencyCheck:pass});assert.equal(result.uncertain,true);assert.equal(sends,1);assert.equal(cleaned,1);
});
test('再催促アダプタの直接送信も必須検査を通る',async()=>{
 let sends=0;
 const b=createBeeperAdapter({resolveBeeperTarget:()=>({token:'mock',via:'test'}),sendMessage:async()=>{sends++;return{id:'m'};},consistencyCheck:blocked,cleanup});
 assert.equal((await b.send({chatId:'chat',id:'row'},'本文')).ok,false);
 const d=createDiscordAdapter({resolveDiscordBotToken:()=> 'mock',fetchImpl:async()=>{sends++;return res({id:'m'});},consistencyCheck:blocked,cleanup});
 assert.equal((await d.send({chatId:'chat',id:'row'},'本文')).ok,false);assert.equal(sends,0);
});
test('承認ゲートも整合性NGの箇所を返す',async()=>{
 const result=await judgeLive({tool_name:'mcp__claude_ai_Gmail__send_message',tool_input:{to:'a@example.com',body:'本文'},
  transcript:[{type:'assistant',content:'本文'},{type:'user',content:'送って'}]},
  {requireContext:false,consistencyCheck:blocked});
 assert.equal(result.decision,'block');assert.match(result.reason,/UNVERIFIED_sentHistory/);
});
