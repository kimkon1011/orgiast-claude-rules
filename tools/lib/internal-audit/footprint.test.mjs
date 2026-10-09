import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildFootprint, searchTerm, createDiscord, createDriveSource, createGmailSource } from './footprint.mjs';
test('name normalization removes corporate prefix and preserves query words',()=>{assert.equal(searchTerm(' 株式会社 ＡＢＣ　商店 '),'ABC 商店');assert.equal(searchTerm('(有) テスト'),'テスト');});
async function dir(t){const d=await fs.mkdtemp(path.join(os.tmpdir(),'ia-fp-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;}
test('all-zero controls unverified, a positive paid vendor validates zero; skip ignores cache',async t=>{
 const stateDir=await dir(t),partners=[{id:'a',name:'Alpha'},{id:'control',name:'Control'}],now=new Date('2026-10-09');
 const fn=async()=>({status:'ok',count:0});let r=await buildFootprint(partners,{stateDir,now,sources:{gmail:fn,drive:fn,discord:fn}});assert.equal(r.a.gmail.status,'unverified');
 const source=async term=>({status:'ok',count:term==='Control'?1:0});r=await buildFootprint(partners,{stateDir,now,sources:{gmail:source,drive:source,discord:source}});assert.ok(r.a.gmail.controlVerified);assert.equal(r.a.gmail.count,0);
 r=await buildFootprint(partners,{stateDir,now,sources:{}});assert.equal(r.a.gmail.count,null);assert.equal(r.a.gmail.status,'unverified');
});
test('one source failure does not block positive source; cache window invalidation',async t=>{
 const stateDir=await dir(t);let n=0;const source=async()=>{n++;return{status:'ok',count:1}};
 const opts={stateDir,now:new Date('2026-10-09'),sources:{gmail:source,drive:async()=>{throw Error('token should never escape');}}};
 let r=await buildFootprint([{id:'a',name:'Alpha'}],opts);assert.equal(r.a.drive.status,'failed');assert.ok(!r.a.drive.reason.includes('token should'));
 await buildFootprint([{id:'a',name:'Alpha'}],opts);assert.equal(n,1);await buildFootprint([{id:'a',name:'Alpha'}],{...opts,window:90});assert.equal(n,2);
});
test('Drive all three identities, fullText escaping and pagination',async()=>{
 const calls=[];const google={request:async(u,user)=>{const url=new URL(u);calls.push([url,user]);return url.searchParams.has('pageToken')?{files:[]}:{files:[{id:user,name:'x',modifiedTime:'2026-10-01'}],nextPageToken:'next'};}};
 const r=await createDriveSource({google,now:new Date('2026-10-09')})("O'Neil",180);assert.equal(r.count,3);assert.equal(calls.length,6);assert.ok(calls[0][0].searchParams.get('q').includes("O\\'Neil"));
});
test('Discord search 403 fallback uses GET and caches metadata only',async t=>{
 const stateDir=await dir(t),calls=[];
 const fetchImpl=async(u,o)=>{calls.push([u,o]);if(u.includes('/messages/search'))return{ok:false,status:403};let result=u.endsWith('/channels')?[{id:'chan',type:0,name:'work'}]:[{id:'msg',content:'Alpha delivery confidential',timestamp:'2026-10-08T00:00:00Z'}];return{ok:true,json:async()=>result};};
 const d=createDiscord({token:'secret',fetchImpl,stateDir,partners:[{id:'a',name:'Alpha'}],now:new Date('2026-10-09')});const r=await d.search('Alpha',180);assert.equal(r.count,1);assert.equal(r.status,'unverified');assert.ok(calls.every(([,o])=>o.method==='GET'&&o.headers['User-Agent']));const cache=await fs.readFile(path.join(stateDir,'discord-cache.json'),'utf8');assert.ok(!cache.includes('confidential'));
});
