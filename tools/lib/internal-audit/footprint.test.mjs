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

test('Gmail uses actual first-page stubs, exact phrase and preferred subject/from; no estimates', async () => {
  const queries = [];
  const fetchImpl = async url => {
    const u = new URL(url);
    if (u.pathname.endsWith('/messages')) {
      queries.push(u.searchParams);
      return { ok: true, json: async () => ({ resultSizeEstimate: 999999, messages: [{ id: 'a' }, { id: 'b' }] }) };
    }
    const preferred = u.pathname.endsWith('/b');
    return { ok: true, json: async () => ({ payload: { headers: [
      { name: 'Subject', value: preferred ? 'Alpha Beta delivery' : 'unrelated newest' },
      { name: 'Date', value: preferred ? '2026-09-01' : '2026-10-01' },
    ] } }) };
  };
  const result = await createGmailSource({ google: { getToken: async () => 'test' }, fetchImpl })('Alpha Beta', 90);
  assert.equal(result.count, 6); assert.equal(result.lowerBound, false);
  assert.equal(result.representative, 'Alpha Beta delivery');
  assert.ok(queries.every(q => q.get('maxResults') === '100' && q.get('q') === '"Alpha Beta" newer_than:90d'));
});
test('Gmail 100 list entries mark lower bound; missing list is zero', async () => {
  for (const size of [0, 100]) {
    const fetchImpl = async url => ({ ok: true, json: async () => new URL(url).pathname.endsWith('/messages')
      ? { resultSizeEstimate: 9999, messages: Array.from({ length: size }, (_, i) => ({ id: String(i) })) }
      : { payload: { headers: [{ name: 'From', value: 'Alpha' }] } } });
    const result = await createGmailSource({ google: { getToken: async () => 'test' }, fetchImpl })('Alpha', 90);
    assert.equal(result.count, size * 3); assert.equal(result.lowerBound, size === 100);
  }
});
test('generic partners skip all sources including cached hits', async t => {
  const stateDir = await dir(t);
  const fn = async () => { throw Error('must not call'); };
  const r = await buildFootprint([{ id: 'a', name: 'その他' }], { stateDir, patterns: { generic_partner_names: ['その他'] }, sources: { gmail: fn, drive: fn, discord: fn } });
  for (const value of Object.values(r.a)) { assert.equal(value.status, 'unverified'); assert.match(value.reason, /汎用取引先名/); }
});

test('legacy estimated Gmail cache remains reusable but cannot claim an actual count', async t => {
  const stateDir = await dir(t), now = new Date('2026-10-09');
  await fs.writeFile(path.join(stateDir, 'footprint-cache.json'), JSON.stringify({ 'a+2026-10': { term: 'Alpha', window: 90, at: now.toISOString(), results: { gmail: { status: 'ok', count: 999, countKind: '推定件数' } } } }));
  const args = { stateDir, now, window: 90, sources: { gmail: async () => { throw Error('must reuse'); } } };
  for (let i = 0; i < 2; i++) {
    const r = await buildFootprint([{ id: 'a', name: 'Alpha' }], args);
    assert.equal(r.a.gmail.status, 'unverified'); assert.equal(r.a.gmail.count, null); assert.equal(r.a.gmail.controlVerified, false);
  }
});

test('legacy snapshot estimates and generic cached hits become unverified', async () => {
  const { normalizeSavedFootprint } = await import('./footprint.mjs');
  const snapshot = { partners: [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'その他' }], footprint: {
    a: { gmail: { status: 'ok', count: 9000, countKind: '推定件数' } },
    b: { gmail: { status: 'ok', count: 3 }, drive: { status: 'ok', count: 1 }, discord: { status: 'ok', count: 1 } },
  } };
  const sources = {};
  normalizeSavedFootprint(snapshot, { generic_partner_names: ['その他'] }, sources);
  assert.equal(snapshot.footprint.a.gmail.count, null);
  assert.equal(snapshot.footprint.b.drive.count, null);
  assert.equal(sources.gmail.status, 'unverified'); assert.equal(sources.gmail.count, 0);
});
