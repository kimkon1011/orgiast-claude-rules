import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { diffExternalShares, analyzeAdmin, scanAdmin, ADMIN_SCOPE, scanDrive } from './exfil.mjs';
const {thresholds}=JSON.parse(fs.readFileSync(new URL('../../internal-audit-patterns.json',import.meta.url)));
test('external sharing diff, anyone medium, exact internal domain and role change',()=>{
 const files=[{id:'f',name:'test',permissions:[{id:'a',type:'anyone',role:'reader'},{id:'b',type:'user',emailAddress:'x@outside.invalid',role:'writer'},{id:'c',type:'domain',domain:'orgiast.jp',role:'reader'},{id:'d',type:'user',emailAddress:'x@orgiast.jp.evil.invalid',role:'reader'}]}];
 const first=diffExternalShares(files);assert.equal(first.findings.length,3);assert.equal(first.findings[0].severity,'medium');assert.equal(first.findings[1].severity,'high');const second=diffExternalShares(files,first.keys);assert.equal(second.knownCount,3);assert.equal(second.findings[0].severity,'info');files[0].permissions[1].role='reader';assert.ok(diffExternalShares(files,first.keys).findings.some(f=>f.severity==='high'));
});
test('unauthorized_client is unverified with setup instructions and no API call',async()=>{
 const google={getToken:async()=>{throw Error('unauthorized_client')},request:async()=>{throw Error('must not call')}};const r=await scanAdmin({google,state:{},clientId:'test-client',thresholds});assert.equal(r.sources.admin.status,'unverified');assert.ok(r.sources.admin.reason.includes(ADMIN_SCOPE));assert.ok(r.sources.admin.reason.includes('test-client'));assert.ok(r.sources.admin.reason.includes('次回実行から自動'));
});
const activity=(name,time,parameters=[],app='drive')=>({id:{time,applicationName:app,uniqueQualifier:time+name},actor:{email:'staff@orgiast.jp'},events:[{name,parameters}]});
test('download rolling day/week, view ignored, external changes and OAuth dedup',()=>{
 const rows=Array.from({length:thresholds.download_day},(_,i)=>activity('download',new Date(Date.UTC(2026,9,8,0,i)).toISOString(),[{name:'doc_id',value:`f${i}`} ]));
 assert.ok(analyzeAdmin(rows,{thresholds}).findings.some(f=>f.detail.includes('download/export')));
 assert.equal(analyzeAdmin(rows.map(r=>({...r,events:[{name:'view'}]})),{thresholds}).findings.length,0);
 assert.equal(analyzeAdmin(rows.slice(1),{thresholds}).findings.length,0);
 const share=activity('change_user_access','2026-10-08',[{name:'target_user',value:'x@outside.invalid'}]);assert.equal(analyzeAdmin([share],{thresholds}).findings[0].severity,'high');
 const auth=activity('authorize','2026-10-08',[{name:'client_id',value:'app-test'}],'token');assert.equal(analyzeAdmin([auth],{thresholds}).findings.length,1);assert.equal(analyzeAdmin([auth],{thresholds,knownOAuth:['app-test']}).findings.length,0);
});
test('partial Drive scan preserves known baseline',async()=>{const r=await scanDrive({known:['old'],google:{request:async()=>{throw Error('no access')}}});assert.deepEqual(r.keys,['old']);assert.ok(Object.values(r.sources).every(s=>s.status==='unverified'));});
test('document shared_externally and folder addition detected; revoked access not high',()=>{
 const params=[{name:'visibility',value:'shared_externally'}];for(const name of ['change_document_visibility','add_to_folder'])assert.equal(analyzeAdmin([activity(name,'2026-10-08',params)],{thresholds}).findings[0].severity,'high');
 const revoke=activity('change_user_access','2026-10-08',[{name:'target_user',value:'x@outside.invalid'},{name:'new_value',value:'none'}]);assert.equal(analyzeAdmin([revoke],{thresholds}).findings.length,0);
});
test('repeated page token marks Drive incomplete and does not erase baseline',async()=>{
 let calls=0;const google={request:async()=>{calls++;return{files:[],nextPageToken:'repeated'}}};const r=await scanDrive({google,known:['existing']});assert.equal(calls,6);assert.deepEqual(r.keys,['existing']);assert.ok(Object.values(r.sources).every(s=>s.status==='unverified'&&s.reason.includes('反復')));
});
test('one large owner cannot consume every source budget',async()=>{
 let clock=0;const google={request:async()=>{clock+=100;return{files:[],nextPageToken:String(clock)}}};const r=await scanDrive({google,userBudgetMs:100,nowMillis:()=>clock});assert.equal(Object.keys(r.sources).length,3);assert.ok(Object.values(r.sources).every(s=>s.status==='unverified'&&s.reason.includes('時間上限')));
});
test('large external-share collections are representable without variadic array calls',()=>{
 const files=Array.from({length:150000},(_,i)=>({id:`f-${i}`,name:'synthetic',permissions:[{id:'p',type:'anyone',role:'reader'}]}));const r=diffExternalShares(files);assert.equal(r.findings.length,files.length);assert.equal(r.keys.length,files.length);
});

test('first complete scan builds baseline; later modified-only run reports only new shares with owner', async () => {
  const state = {}; let added = false;
  const queries = [];
  const google = { request: async (url, user) => {
    queries.push(new URL(url).searchParams.get('q'));
    return { files: [{ id: user, name: 'file', webViewLink: 'https://drive.google.com/file/d/test/view',
      permissions: [{ id: 'old', type: 'anyone', role: 'reader' }, ...(added ? [{ id: 'new', type: 'domain', domain: 'example.invalid', role: 'reader' }] : [])] }] };
  } };
  const first = await scanDrive({ google, state });
  assert.equal(first.findings.length, 1); assert.equal(first.findings[0].severity, 'info');
  assert.equal(first.baseline.summary.reduce((n, r) => n + r.count, 0), 3);
  assert.ok(queries[0].includes("visibility = 'anyoneWithLink'"));
  assert.ok(Object.values(state.driveScan).every(c => c.completedAt && c.modifiedCursor && !c.pageToken));
  added = true; queries.length = 0;
  const next = await scanDrive({ google, state });
  assert.equal(next.findings.filter(f => f.severity === 'high').length, 3);
  assert.ok(next.findings.filter(f => f.severity === 'high').every(f => f.owner && f.url));
  assert.ok(queries.every(q => q.includes('modifiedTime >')));
  // Only report persistence acknowledges discoveries.
  assert.equal(Object.keys(state.pendingExternalFindings).length, 3);
  for (const key of next.acknowledgedKeys) delete state.pendingExternalFindings[key];
  assert.equal((await scanDrive({ google, state })).findings.length, 1);
});
test('partial ownership baseline resumes exact page without modified cursor advancement', async () => {
  let clock = Date.parse('2026-10-09'), resume = false;
  const state = {}, calls = [];
  const google = { request: async (url, user) => {
    const u = new URL(url); calls.push([user, u.searchParams.get('pageToken')]);
    if (u.searchParams.get('q').includes('visibility')) return { files: [] };
    if (!resume) { clock += 100; return { files: [{ id: user, permissions: [{ id: 'a', type: 'anyone', role: 'reader' }] }], nextPageToken: 'resume-here' }; }
    assert.equal(u.searchParams.get('pageToken'), 'resume-here');
    return { files: [] };
  } };
  const first = await scanDrive({ google, state, userBudgetMs: 100, nowMillis: () => clock });
  assert.equal(first.findings.length, 1);
  assert.ok(Object.values(state.driveScan).every(c => c.pageToken === 'resume-here' && !c.completedAt && !c.modifiedCursor));
  assert.ok(Object.values(first.sources).every(s => s.reason.includes('再開位置あり・次回継続')));
  resume = true;
  const second = await scanDrive({ google, state, userBudgetMs: 1000, nowMillis: () => clock });
  assert.equal(second.findings.length, 1);
  assert.ok(Object.values(state.driveScan).every(c => !c.pageToken && c.completedAt));
});
test('missing knownExternalShares suppresses file findings even with completed legacy cursor', async () => {
  const state = { driveScan: { 'kim@orgiast.jp': { completedAt: '2026-10-08', modifiedCursor: '2026-10-08T00:00:00Z' } } };
  const r = await scanDrive({ state, google: { request: async () => ({ files: [{ id: 'f', permissions: [{ type: 'anyone' }] }] }) } });
  assert.ok(r.findings.every(f => f.severity === 'info'));
});

test('partial incremental discoveries wait until a later complete run and survive checkpoints', async () => {
  let clock = 0, partial = false;
  const state = {};
  const google = { request: async (url, user) => {
    const u = new URL(url);
    if (u.searchParams.get('q').includes('visibility')) return { files: [] };
    if (partial && user === 'kim@orgiast.jp') { clock += 100; return { files: [{ id: 'new-file', name: 'new', permissions: [{ id: 'p', type: 'anyone', role: 'reader' }] }], nextPageToken: 'remaining' }; }
    return { files: [] };
  } };
  await scanDrive({ google, state, nowMillis: () => clock });
  partial = true;
  const incomplete = await scanDrive({ google, state, userBudgetMs: 100, nowMillis: () => clock });
  assert.ok(incomplete.findings.every(f => f.severity === 'info'));
  assert.equal(Object.keys(state.pendingExternalFindings).length, 1);
  partial = false;
  const resumed = await scanDrive({ google, state, nowMillis: () => clock });
  assert.ok(resumed.findings.every(f => f.severity === 'info'));
  const complete = await scanDrive({ google, state, nowMillis: () => clock });
  assert.equal(complete.findings.filter(f => f.severity === 'medium').length, 1);
  assert.equal(complete.acknowledgedKeys.length, 1);
});
