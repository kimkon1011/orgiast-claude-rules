import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gwsFetch,proxyCredential,GWS_MARKER,channelRequest} from './lib/gws-proxy.mjs';
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
