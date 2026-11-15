import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gwsFetch,proxyCredential,GWS_MARKER,channelRequest,retrySource} from './lib/gws-proxy.mjs';
import {collectLineRows,syncLineHistory} from './line-history-sync.mjs';
import {syncKnowledge} from './onboarding-sync.mjs';
test('missing key routes only fixed account and approved scopes without token relay',()=>{
 assert.equal(proxyCredential({keyPath:'nonexistent',impersonate:'seisaku-team@orgiast.jp',scope:'https://www.googleapis.com/auth/drive'}),GWS_MARKER);
 assert.throws(()=>proxyCredential({keyPath:'nonexistent',impersonate:'kim@orgiast.jp',scope:'https://www.googleapis.com/auth/drive'}));
 assert.throws(()=>proxyCredential({keyPath:'nonexistent',impersonate:'seisaku-team@orgiast.jp',scope:'https://www.googleapis.com/auth/cloud-platform'}));
});
test('proxy preserves binary bytes, uses GET reads and never sends Google marker to Google',async()=>{
 const calls=[];const request=async(route,opts)=>{calls.push({route,opts});return {status:200,body:Buffer.from([0,128,255]).toString('base64')};};
 let res=await gwsFetch('https://www.googleapis.com/drive/v3/files/id?alt=media',{headers:{Authorization:`Bearer ${GWS_MARKER}`}},{request});
 assert.deepEqual(Buffer.from(await res.arrayBuffer()),Buffer.from([0,128,255]));assert.ok(calls[0].opts.query);assert.equal(calls[0].opts.body,undefined);
 await gwsFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',{method:'POST',headers:{Authorization:`Bearer ${GWS_MARKER}`},body:Buffer.from([0,128,255])},{request});
 assert.deepEqual(Buffer.from(calls[1].opts.body.body,'base64'),Buffer.from([0,128,255]));
 await assert.rejects(gwsFetch('https://evil.invalid/',{headers:{Authorization:`Bearer ${GWS_MARKER}`}},{request}));
});
test('enrolled API request has no Google token and rejects redirects',async()=>{
 const result=await channelRequest('gws',{home:'nonexistent',env:{ORGIAST_KEYSERVE_SECRET:'enroll-secret',ORGIAST_KEYSERVE_PC:'WORK008'},query:{service:'drive',path:'/drive/v3/files'},fetchImpl:async(url,opts)=>{
  assert.equal(opts.method,'GET');assert.equal(opts.redirect,'error');assert.equal(opts.headers['x-orgiast-pc'],'WORK008');assert.equal(opts.headers.Authorization,undefined);assert.ok(!JSON.stringify(opts).includes('enroll-secret'));return Response.json({ok:true});
 }});assert.equal(result.ok,true);
});
const retryDeps=delays=>({home:'nonexistent',env:{ORGIAST_KEYSERVE_SECRET:'enroll-secret',ORGIAST_KEYSERVE_PC:'WORK008'},sleepImpl:async ms=>{delays.push(ms);}});
test('channel gws の5xxは1分→3分→10分の計4回であきらめる（2026-11-13 06:30の再現）',async()=>{
 const delays=[];let calls=0;
 await assert.rejects(retrySource(()=>channelRequest('gws',{...retryDeps(delays),query:{service:'sheets',path:'/x'},fetchImpl:async()=>{calls++;return new Response('down',{status:calls===2?503:500});}}),retryDeps(delays)),/HTTP 500/);
 assert.equal(calls,4);assert.deepEqual(delays,[60000,180000,600000]);
});
test('channel gws の5xx・ネットワークエラーは再試行で復帰する',async()=>{
 const delays=[];let calls=0;
 const result=await retrySource(()=>channelRequest('gws',{...retryDeps(delays),query:{},fetchImpl:async()=>{calls++;if(calls===1)return new Response('bad gateway',{status:502});if(calls===2)throw new Error('fetch failed');return Response.json({ok:true});}}),retryDeps(delays));
 assert.equal(result.ok,true);assert.equal(calls,3);assert.deepEqual(delays,[60000,180000]);
});
test('channel gws の4xxと鍵欠落は再試行しない',async()=>{
 const delays=[];let calls=0;
 await assert.rejects(retrySource(()=>channelRequest('gws',{...retryDeps(delays),query:{},fetchImpl:async()=>{calls++;return new Response('nope',{status:404});}}),retryDeps(delays)),/HTTP 404/);
 assert.equal(calls,1);assert.deepEqual(delays,[]);
 await assert.rejects(channelRequest('gws',{home:'nonexistent',env:{},query:{},fetchImpl:async()=>{calls++;return Response.json({});}}),/keyserve enrollment credential missing/);
 assert.equal(calls,1);assert.deepEqual(delays,[]);
});

test('source retry creates fresh timeout signals and handles upstream Google 5xx',async()=>{
 const delays=[],signals=[];let calls=0;
 const result=await retrySource(async()=>{
   const signal=AbortSignal.timeout(30000);signals.push(signal);
   const response=await gwsFetch('https://sheets.googleapis.com/v4/spreadsheets/s/values/A1',{headers:{Authorization:`Bearer ${GWS_MARKER}`},signal},{request:async()=>({status:++calls<3?503:200,body:Buffer.from('{}').toString('base64')})});
   if(!response.ok)throw Object.assign(Error('Google failure'),{status:response.status});
   return response.json();
 },retryDeps(delays));
 assert.deepEqual(result,{});assert.equal(new Set(signals).size,3);assert.deepEqual(delays,[60000,180000]);
 let timeoutCalls=0;
 await retrySource(async()=>{if(++timeoutCalls===1)throw new DOMException('expired','TimeoutError');},retryDeps([]));
 assert.equal(timeoutCalls,2);
});

test('shared channel writes are never automatically retried',async()=>{
 let calls=0;
 await assert.rejects(channelRequest('line',{...retryDeps([]),body:{text:'hello'},fetchImpl:async()=>{calls++;throw Error('fetch failed');}}),/fetch failed/);
 assert.equal(calls,1);
});
test('LINE sync reads both existing formats, deduplicates by ID and appends RAW values only',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'line-sync-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 for(const dir of ['line-openchat','line-oa'])fs.mkdirSync(path.join(home,'.claude',dir),{recursive:true});
 const row={id:'one',ts:1,chat:'cafe',sender:'person',text:'=IMPORTXML("x")'};
 fs.writeFileSync(path.join(home,'.claude/line-openchat/2026-11.jsonl'),[row,row].map(JSON.stringify).join('\n'));
 fs.writeFileSync(path.join(home,'.claude/line-oa/events-2026-11.jsonl'),JSON.stringify({type:'message',timestamp:2,message:{id:'two',type:'text',text:'hello'},source:{userId:'someone'}}));
 assert.equal(collectLineRows(home).length,2);
 const calls=[];await syncLineHistory({home,config:{sheetId:'sheet'},getToken:async()=> 'secret',fetchImpl:async(url,opts)=>{
  calls.push([url,opts]);if(!opts.method)return Response.json({values:[['id'],['line-openchat:one']]});return Response.json({});
 }});
 const append=calls.find(([url])=>url.includes(':append'));assert.ok(append[0].includes('valueInputOption=RAW'));assert.equal(JSON.parse(append[1].body).values.length,1);
 calls.length=0;await syncLineHistory({home,config:{sheetId:'sheet'},dryRun:true,getToken:async()=> 'secret',fetchImpl:async(url,opts)=>{calls.push(opts);return Response.json({values:[['id']]});}});assert.ok(calls.every(x=>!x.method));
});

test('knowledge success marker cannot hide a missing index; existing index retains daily throttle',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'knowledge-repair-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'.claude'),{recursive:true});fs.writeFileSync(path.join(home,'.claude/.knowledge-sync-state.json'),JSON.stringify({last:new Date().toISOString()}));
 let installs=0;const options={targetHome:home,forced:false,preview:false,emit:()=>{},install:async()=>{installs++;return{updated:1};}};
 await syncKnowledge(options);assert.equal(installs,1);
 const dir=path.join(home,'.claude/knowledge/production-sales');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'00_INDEX.md'),'index');
 await syncKnowledge(options);assert.equal(installs,1);
});
