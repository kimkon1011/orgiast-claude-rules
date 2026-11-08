import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { matchCase, exclusion, processPage, run, SOURCES, createDriveSink, parseArgs, publishedText, parseEntries, collectSource, render, parseCaseRows, writeLastRun, createPhaseTracker } from './comms-hub-sync.mjs';

// All tests must use a temp ORGIAST_HOME so no run() call writes to ~/.claude
const testHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-test-home-'));
const priorOrgHome = process.env.ORGIAST_HOME;
process.env.ORGIAST_HOME = testHome;
const homedirLastRunPath = path.join(os.homedir(), '.claude', 'comms-hub', 'last-run.json');
let homedirLastRunBefore = null;
try { homedirLastRunBefore = { exists: true, mtimeMs: fs.statSync(homedirLastRunPath).mtimeMs }; }
catch (e) { if (e.code === 'ENOENT') homedirLastRunBefore = { exists: false }; else throw e; }
after(() => {
  process.env.ORGIAST_HOME = priorOrgHome;
  try { const s = fs.statSync(homedirLastRunPath); assert.equal(s.mtimeMs, homedirLastRunBefore.mtimeMs, 'homedir last-run.json mtime changed'); }
  catch (e) { if (e.code === 'ENOENT') assert.ok(!homedirLastRunBefore.exists, 'homedir last-run.json was created'); else throw e; }
  fs.rmSync(testHome, { recursive: true, force: true });
});
// Helper: create a temp dir for test home (used by collectSource) and clean up on test finish
function makeTestHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'comms-hub-test-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  return dir;
}
const config = JSON.parse(fs.readFileSync(new URL('../config/comms-hub.json', import.meta.url)));
const cases = [{ id: '261101ABC', name: '展示会Alpha', client: '共通顧客' }, { id: 'C1234', name: '制作Beta', client: '共通顧客' }];
const message = { source: 'gmail-kim', id: 'same', ts: '2026-11-01T02:00:00.000Z', subject: '261101ABC 見積', text: '業務連絡', sender: 'staff@example.test' };
test('rules: explicit ID, ambiguity, names, thread/channel, unknown ID', () => {
  assert.equal(matchCase(message,cases,config).id, cases[0].id);
  for (const text of ['共通顧客', '261101ABC C1234', 'C9999 展示会Alpha', 'X261101ABCZ']) assert.equal(matchCase({text},cases,config), null);
  assert.equal(matchCase({text:'展示会Alpha'},cases,config).id, cases[0].id);
  assert.equal(matchCase({source:'gmail-kim',threadId:'t'},cases,{threadCases:{'gmail-kim:t':'C1234'}}).id,'C1234');
  assert.equal(matchCase({channelId:'ch'},cases,{channelCases:{ch:'C1234'}}).id,'C1234');
});
test('exclusions override case match; uncertain personal content never published', () => {
  for (const text of ['GitHub 通知','私用の案件','認証コード']) assert.ok(exclusion({...message,text},config,cases[0]));
  assert.ok(exclusion({...message,listUnsubscribe:'unsubscribe'},config,cases[0]));
  assert.ok(exclusion({...message,subject:'こんにちは',text:'元気ですか'},config,null));
  assert.equal(exclusion({...message,subject:'見積依頼'},config,null),null);
});
function mockDrive() {
  const files = new Map(); let seq=0, writes=0, failAfterUpload=false;
  const json = (x, status=200) => new Response(JSON.stringify(x), {status,headers:{'Content-Type':'application/json'}});
  const fetchImpl = async (url, init={}) => {
    const u = new URL(url), method=init.method || 'GET';
    assert.notEqual(u.hostname, 'docs.googleapis.com', 'Docs API must never be used');
    if (String(url).includes('/permissions')) return Response.json({ permissions: [{ type: 'user', emailAddress: 'kim@orgiast.jp', role: 'writer' }] });
    if (init.method === 'PATCH' && String(init.body).includes('orgiastAutomation')) return Response.json({ id: 'marked' });
    if(method==='GET' && u.pathname.endsWith('/files')) {
      const q=u.searchParams.get('q'), name=/name='([^']+)'/.exec(q)?.[1];
      return json({files:[...files].filter(([,f])=>f.name===name).map(([id])=>({id}))});
    }
    if(method==='GET') {
      const id=u.pathname.split('/')[4], f=files.get(id);
      if(u.pathname.endsWith('/export')) return new Response(f.text);
      if(u.searchParams.get('alt')==='media') return json(JSON.parse(f.text));
    }
    if(method==='POST') {
      let metadata, text='';
      if(u.searchParams.get('uploadType')==='multipart') {
        const parts=init.body.split(/--hub_[^\r\n]+/);
        metadata=JSON.parse(parts[1].split('\r\n\r\n')[1].trim());
        text=parts[2].split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, '');
        assert.equal(metadata.mimeType,'application/vnd.google-apps.document');
        assert.match(parts[2],/text\/markdown/); writes++;
      } else metadata=JSON.parse(init.body);
      const id=`doc${++seq}`; files.set(id,{...metadata,text});
      if(failAfterUpload && metadata.mimeType==='application/vnd.google-apps.document') {failAfterUpload=false;throw Error('response lost');}
      return json({id});
    }
    if(method==='PATCH') {
      assert.equal(u.searchParams.get('uploadType'),'media');
      const id=u.pathname.split('/').at(-1),f=files.get(id);
      f.text=init.body;writes++;
      if(f.mimeType==='application/vnd.google-apps.document') assert.match(init.headers['Content-Type'],/text\/markdown/);
      if(failAfterUpload) {failAfterUpload=false;throw Error('response lost');}
      return json({id});
    }
    throw new Error('unexpected mock route '+url);
  };
  return {fetchImpl,files,get writes(){return writes;}, loseNext(){failAfterUpload=true;}};
}
function fixture(t) {
  const storeDir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-store-'));
  t.after(()=>fs.rmSync(storeDir,{recursive:true,force:true}));
  const api=mockDrive(),state={sources:{'gmail-kim':{},'gmail-seisaku':{}},cases:{},files:{daily:'daily',cases:'cases',unassigned:'unassigned'},rootId:'root'};
  const make=()=>createDriveSink({token:'mock',state,storeDir,now:Date.parse('2026-11-02'),save(){},fetchImpl:api.fetchImpl});
  return {api,state,storeDir,make};
}
test('Drive only: durable dedup, lost response recovery, unchanged hash, chronological order',async t=>{
  const {api,state,storeDir,make}=fixture(t);let sink=make();
  const args={source:message.source,page:{messages:[message],cursor:{since:5}},state,cases,config,sink,live:true};
  await processPage(args);
  assert.equal(api.writes,0,'append commits locally before network publication');
  api.loseNext();await assert.rejects(sink.finish(),/response lost/);
  assert.match(fs.readFileSync(path.join(storeDir,'cases/261101ABC.md'),'utf8'),/業務連絡/);
  sink=make();await sink.finish();
  const writes=api.writes;await processPage({...args,sink});await sink.finish();assert.equal(api.writes,writes);
  await processPage({...args,sink,source:'gmail-seisaku',page:{messages:[{...message,source:'gmail-seisaku'}],cursor:{since:5}}});
  await processPage({...args,sink,page:{messages:[{...message,id:'old',ts:'2026-11-01T01:00:00.000Z'}],cursor:{since:6}}});
  await sink.finish();
  const daily=api.files.get(state.files['daily/2026-11-01']).text;
  const caseText=api.files.get(state.files['cases/261101ABC']).text;
  assert.equal(parseEntries(caseText).length,3);
  assert.ok(daily.indexOf('01:00:00.000Z') < daily.indexOf('02:00:00.000Z'));
  assert.ok(caseText.indexOf('02:00:00.000Z') < caseText.indexOf('01:00:00.000Z'));
  const index=JSON.parse(api.files.get(state.files.index).text);
  assert.ok(Object.hasOwn(index.sources, 'inquiry-sheet'));
  assert.ok(Object.hasOwn(index.sources['inquiry-sheet'], 'lastSuccess'));
  assert.equal(index.cases['261101ABC'].url,`https://docs.google.com/a/orgiast.jp/document/d/${state.files['cases/261101ABC']}/edit`);
});
test('case publication caps age and characters but keeps local complete text',async t=>{
  const {api,state,storeDir,make}=fixture(t),sink=make();
  const key='cases/261101ABC', marker=n=>crypto.createHash('sha256').update(n).digest('hex');
  await sink.append(key,'case',marker('old'),'2026-07-01T00:00:00.000Z','old content');
  await sink.append(key,'case',marker('new'),'2026-11-01T00:00:00.000Z','新'.repeat(210000));
  await sink.finish();
  const local=fs.readFileSync(path.join(storeDir,key+'.md'),'utf8'),remote=api.files.get(state.files[key]).text;
  assert.ok(local.length>210000);assert.match(local,/old content/);
  assert.equal(remote.length,200000);assert.ok(!remote.includes('old content'));
  assert.equal(publishedText('daily/x',local),local);
  assert.ok(render({...message,text:'a'.repeat(110000)},true).length>110000);
  assert.equal(publishedText(key,local,Date.parse('2027-04-01')),'');
});
test('existing Doc migration uses Drive export and preserves prior entries',async t=>{
 const {api,state,make}=fixture(t),sink=make(),key='daily/2026-11-01';
 state.files[key]='old';api.files.set('old',{name:'2026-11-01',mimeType:'application/vnd.google-apps.document',text:`[hub:${'a'.repeat(64)}:2026-11-01T00:00:00.000Z]\nprior\n\n`});
 await sink.append(key,'2026-11-01','b'.repeat(64),message.ts,'new');await sink.finish();
 assert.equal(parseEntries(api.files.get('old').text).length,2);
});
test('partial local commit is replayable without duplicate blocks',async t=>{
 const {state,storeDir,make}=fixture(t),sink=make();
 const args={source:message.source,page:{messages:[message],cursor:{since:5}},state,cases,config,live:true};
 await assert.rejects(processPage({...args,sink:{append:async(...a)=>{if(a[0].startsWith('cases/'))throw Error('disk full');return sink.append(...a);}}}),/disk full/);
 assert.equal(state.sources[message.source].cursor,undefined);
 await processPage({...args,sink});
 assert.equal(parseEntries(fs.readFileSync(path.join(storeDir,'daily/2026-11-01.md'),'utf8')).length,1);
});
test('partial failure is isolated, all failures nonzero, dry-run never writes',async()=>{
  let writes=0;
  const deps={config,cases,state:{sources:{},cases:{}},save(){writes++;},sink:{append(){throw Error('must not write');}},collect:async s=>{if(s==='plaud')throw Error('expired');return {messages:[{...message,source:s}],cursor:{since:1}};}};
  const result=await run({},deps); assert.equal(result.exitCode,0);assert.equal(result.sources.plaud.error,'expired');assert.equal(writes,0);
  deps.collect=async()=>{throw Error('offline');}; assert.equal((await run({},deps)).exitCode,1);
});
test('CLI prohibits conflicting flags and cursor reset in live',()=>{
  assert.throws(()=>parseArgs(['--live','--dry-run']));
  assert.throws(()=>parseArgs(['--live','--since','2d']));
  assert.throws(()=>parseArgs(['--since','nonsense']));
});
test('source cursor advances only after all destinations commit', async () => {
  const state={sources:{'gmail-kim':{cursor:{since:10}}},cases:{}};
  await assert.rejects(processPage({source:'gmail-kim',page:{messages:[message],cursor:{since:20,next:'p2'}},state,cases,config,live:true,sink:{async append(){throw Error('drive denied');}}}));
  assert.deepEqual(state.sources['gmail-kim'].cursor,{since:10});
});
test('Gmail pagination preserves original upper boundary and account', async t => {
  const {collectSource}=await import('./comms-hub-sync.mjs');
  const home=makeTestHome(t);
  const ctx={config,home,since:100000,until:300000,cursor:{end:200000,next:'p1'},state:{},gmailSearch:async args=>{
    assert.equal(args.user,config.mailboxes['gmail-seisaku']); assert.equal(args.pageToken,'p1'); assert.match(args.query,/before:201/);
    return {messages:[],nextPageToken:'p2'};
  }};
  assert.deepEqual((await collectSource('gmail-seisaku',ctx)).cursor,{since:100000,end:200000,next:'p2'});
});
test('Discord resumes a full page even when legacy truncated flag is false', async t=>{
  const {collectSource}=await import('./comms-hub-sync.mjs');
  const home=makeTestHome(t);
  const ctx={config:{...config,maxPerSource:1},home,since:0,until:Date.now(),state:{},discordToken:'mock',listChannels:async()=>[{id:'a',type:0,name:'work'}],discordFetch:async()=>({truncated:false,messages:[{id:'m',timestamp:message.ts,content:'見積',author:{username:'staff'}}]})};
  const page=await collectSource('discord',ctx);
  assert.equal(page.cursor.before,'m'); assert.equal(page.cursor.channel,'a');
});
test('Plaud adapter reads existing transcript without import or credential persistence',async()=>{
  const os=await import('node:os'), path=await import('node:path');
  const {collectPlaudForHub}=await import('./plaud-to-tldv.mjs');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'hub-plaud-'));
  const sessionFile=path.join(home,'.claude','plaud-to-tldv-state.json');
  fs.mkdirSync(path.dirname(sessionFile));
  const exp=Math.floor(Date.now()/1000)+3600;
  const ut=`a.${Buffer.from(JSON.stringify({exp,region:'aws:us-west-2'})).toString('base64url')}.z`;
  const original=JSON.stringify({session:{ut,workspaceId:'workspace',wt:'mock',wtExp:exp}});
  fs.writeFileSync(sessionFile,original);
  const now=Date.now(), urls=[];
  try {
    const p=await collectPlaudForHub({home,since:now-86400000,until:now,config,fetchImpl:async(url,init={})=>{
      assert.ok(!init.method || init.method==='GET');
      urls.push(url);
      const body=url.includes('/file/simple/')?{status:0,data_file_total:1,data_file_list:[{id:'p',filename:'見積会議',start_time:Math.floor((now-1000)/1000)}]}:url.includes('/file/detail/')?{status:0,data:{content_list:[{data_type:'transaction',data_link:'https://example.test/transcript'}]}}:[{speaker:'staff',content:'業務連絡'}];
      return new Response(JSON.stringify(body));
    }});
    assert.equal(p.messages[0].text,'staff: 業務連絡');
    assert.equal(urls.length,3);assert.ok(urls[1].includes('/file/detail/p'));
    assert.equal(fs.readFileSync(sessionFile,'utf8'),original);
  } finally {fs.rmSync(home,{recursive:true,force:true});}
});
test('publication failure preserves source results and creation counts in report',async()=>{
 const state={sources:{},cases:{},rootId:'root'};
 const report=await run({live:true},{config,cases,state,save(){},collect:async()=>({messages:[],cursor:{since:1}}),sink:{createdDocs:2,async init(){},async finish(){throw Error('API HTTP 403 SERVICE_DISABLED');}}});
 assert.equal(report.exitCode,0);assert.equal(report.createdDocs,2);assert.equal(report.rootId,'root');
 assert.equal(Object.keys(report.sources).length,SOURCES.length);assert.match(state.publishError,/SERVICE_DISABLED/);
});

test('tl;dv missing transcript keeps metadata, continues page, records error and later upgrades',async t=>{
 const {state,storeDir,make}=fixture(t);state.sources.tldv={};const sink=make();
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'hub-tldv-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'.claude'));fs.writeFileSync(path.join(home,'.claude','tldv.env'),'TLDV_API_KEY=mock');
 let repaired=false;
 const ctx={config,home,since:0,until:Date.now(),state:state.sources.tldv,fetchImpl:async url=>{
  if(!url.includes('/transcript'))return Response.json({results:[{id:'a',happenedAt:message.ts,name:message.subject,url:'https://example.test/a'},{id:'b',happenedAt:message.ts,name:message.subject}],pages:1});
  return url.includes('/a/')&&!repaired?Response.json({error:{}},{status:404}):Response.json({data:[{speaker:'staff',text:'recovered transcript'}]});
 }};
 const page=await collectSource('tldv',ctx);assert.equal(page.messages.length,2);assert.equal(page.messages[0].text,'');assert.match(page.messages[0].transcriptError,/404/);
 const args={source:'tldv',state,cases,config,sink,live:true};await processPage({...args,page});
 assert.match(state.sources.tldv.transcriptFailures.a.reason,/404/);
 repaired=true;await processPage({...args,page:await collectSource('tldv',ctx)});
 assert.deepEqual(state.sources.tldv.transcriptFailures,{});
 const text=fs.readFileSync(path.join(storeDir,'cases/261101ABC.md'),'utf8');
 assert.equal(parseEntries(text).length,2);assert.equal(text.match(/recovered transcript/g).length,2);
});
test('index distinguishes partial transcript failure from full success',async()=>{
 const state={sources:{plaud:{lastSuccess:'2026-10-01T00:00:00.000Z'}},cases:{}};
 const report=await run({live:true},{config,cases,state,save(){},collect:async source=>({messages:source==='plaud'?[{...message,source,transcriptError:'artifact missing',text:''}]:[],cursor:{since:1}}),sink:{createdDocs:0,async init(){},async append(){},async finish(){return {};}}});
 assert.equal(report.exitCode,0);assert.equal(state.sources.plaud.lastSuccess,'2026-10-01T00:00:00.000Z');assert.match(state.sources.plaud.error,/artifact missing/);
 assert.ok(state.sources.tldv.lastSuccess);
});

test('Plaud isolates missing, failed and empty transcripts while retaining metadata',async t=>{
 const {collectPlaudForHub}=await import('./plaud-to-tldv.mjs');
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'hub-plaud-fallback-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const sessionFile=path.join(home,'.claude','plaud-to-tldv-state.json');fs.mkdirSync(path.dirname(sessionFile));
 const exp=Math.floor(Date.now()/1000)+3600;
 const ut=`a.${Buffer.from(JSON.stringify({exp,region:'aws:us-west-2'})).toString('base64url')}.z`;
 fs.writeFileSync(sessionFile,JSON.stringify({session:{ut,workspaceId:'workspace',wt:'mock',wtExp:exp}}));
 const now=Date.now();
 const page=await collectPlaudForHub({home,since:now-86400000,until:now,config,fetchImpl:async url=>{
  if(url.includes('/file/simple/')) return Response.json({status:0,data_file_total:4,data_file_list:['missing','denied','empty','ok'].map(id=>({id,filename:'見積会議 '+id,start_time:Math.floor((now-1000)/1000)}))});
  if(url.includes('/file/detail/')) {const id=url.split('/').at(-1);return Response.json({status:0,data:{content_list:id==='missing'?[]:[{data_type:'transaction',data_link:`https://example.test/${id}`}]}});}
  if(url.endsWith('/denied'))return new Response('',{status:403});
  return Response.json(url.endsWith('/empty')?[{speaker:'staff',content:''}]:[{speaker:'staff',content:'業務連絡'}]);
 }});
 assert.equal(page.messages.length,4);assert.equal(page.messages.filter(m=>m.transcriptError).length,3);
 assert.equal(page.messages[0].text,'');assert.match(page.messages[0].subject,/見積会議/);assert.ok(page.messages[0].url);
 assert.equal(page.messages[3].text,'staff: 業務連絡');assert.equal(page.cursor.since,now);
});

test('case sheet resolves real I/J/K headers and deduplicates repeated case IDs',()=>{
 const headers=['','予算項目','顧客名','実施計画URL','見積書URL','範囲','請求カウント','一覧カウント','ｺｰﾄﾞ','クライアント名','案件名'];
 const row=['第21期4Q','アプローチリスト','顧客の別名','','','','','','261101ABC','顧客本名','展示会Alpha'];
 const parsed=parseCaseRows([headers,row,row]);assert.equal(parsed.length,1);
 assert.deepEqual(parsed[0],{id:'261101ABC',client:'顧客本名',name:'展示会Alpha'});
 assert.equal(matchCase(message,parsed,config).id,'261101ABC');
 assert.throws(()=>parseCaseRows([['wrong'],['261101ABC']]),/headers/);
 assert.throws(()=>parseCaseRows([headers,[]]),/no valid/);
});

test('init removes broad and unlisted access, downgrades readers, sends no notifications',async()=>{
 const permissions=[{id:'kim',type:'user',emailAddress:'kim@orgiast.jp',role:'writer'},{id:'domain',type:'domain',role:'reader'},{id:'public',type:'anyone',role:'reader'},{id:'other',type:'user',emailAddress:'other@example.test',role:'reader'},{id:'owner',type:'user',role:'owner'},{id:'existing',type:'user',emailAddress:config.readers[0],role:'writer'}];
 const calls=[];
 const sink=createDriveSink({token:'mock',state:{files:{root:'root',cases:'cases',daily:'daily',unassigned:'unassigned'}},save(){},fetchImpl:async(url,init)=>{calls.push({url,...init});return Response.json(init.method==='GET'?{permissions}:{id:'ok'});}});
 await sink.init(config.readers);
 assert.deepEqual(calls.filter(c=>c.method==='DELETE').map(c=>c.url.split('/').at(-1)),['domain','public','other']);
 assert.deepEqual(JSON.parse(calls.find(c=>c.method==='PATCH').body),{role:'reader'});
 const posts=calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);
 for(const c of posts){assert.match(c.url,/sendNotificationEmail=false/);assert.equal(JSON.parse(c.body).role,'reader');assert.ok(config.readers.includes(JSON.parse(c.body).emailAddress));}
});
test('Drive soft-line export restored; malformed local data still refused',async t=>{
 const {api,state,make}=fixture(t),sink=make(),key='daily/2026-11-01';
 state.files[key]='old';api.files.set('old',{name:'2026-11-01',mimeType:'application/vnd.google-apps.document',text:`\uFEFF[hub:${'a'.repeat(64)}:${message.ts}] [2026-11-01 11:00:00][tldv][] 見積\nprior\n\n`});
 await sink.append(key,'2026-11-01','b'.repeat(64),message.ts,'new');await sink.finish();
 assert.equal(parseEntries(api.files.get('old').text).length,2);
 assert.throws(()=>parseEntries('broken content'),/refusing/);
});
test('sensitive terms excluded even for matched cases',async()=>{
 for(const text of ['労働審判','弁護士','裁判','訴訟','書記官','給与','人事評価','健康診断']){
  let writes=0;const state={sources:{'gmail-kim':{}},cases:{}};
  const result=await processPage({source:'gmail-kim',page:{messages:[{...message,text}],cursor:{}},state,cases,config,live:true,sink:{append(){writes++;}}});
  assert.equal(result.excluded,1);assert.equal(writes,0);
 }
});
test('policy changes purge all copies including truncated summary; failed upload retries',async t=>{
 const {api,state,storeDir,make}=fixture(t);let sink=make();const marker='c'.repeat(64);
 await sink.append('daily/2026-11-01','2026-11-01',marker,message.ts,'harmless summary');
 await sink.append('cases/261101ABC','261101ABC_case',marker,message.ts,'x'.repeat(900)+'労働審判');
 await sink.append('cases/261101ABC','261101ABC_case','d'.repeat(64),message.ts,'keep this');
 await sink.finish();
 sink=createDriveSink({token:'mock',state,storeDir,config,save(){},fetchImpl:api.fetchImpl});
 api.loseNext();await assert.rejects(sink.finish(),/response lost/);
 for(const key of ['daily/2026-11-01','cases/261101ABC'])assert.ok(!fs.readFileSync(path.join(storeDir,key+'.md'),'utf8').includes(marker));
 await sink.finish();assert.equal(api.files.get(state.files['daily/2026-11-01']).text,'\n');
 const text=api.files.get(state.files['cases/261101ABC']).text;assert.ok(!text.includes('労働審判'));assert.match(text,/keep this/);
});

test('purge discovers remote-only Docs and deletes sensitive entries without new messages',async t=>{
 const {api,state,storeDir}=fixture(t),marker='e'.repeat(64);
 api.files.set('remote',{name:'2026-11-01',mimeType:'application/vnd.google-apps.document',text:`[hub:${marker}:${message.ts}] [2026-11-01 11:00:00][tldv][] 労働審判\n\n`});
 const fetchImpl=async(url,init={})=>{
  const u=new URL(url),q=u.searchParams.get('q');
  if(q?.includes("'daily' in parents")&&!q.includes('name='))return Response.json({files:[{id:'remote',name:'2026-11-01'}]});
  return api.fetchImpl(url,init);
 };
 const sink=createDriveSink({token:'mock',state,storeDir,config,save(){},fetchImpl});
 await sink.finish();
 assert.equal(api.files.get('remote').text,'\n');
 assert.equal(fs.readFileSync(path.join(storeDir,'daily/2026-11-01.md'),'utf8'),'');
 assert.equal(state.removedMarkers[marker],true);
});

test('upload timeout retries twice with exponential backoff and fresh signals; lost create is recovered',async t=>{
 const {api,state,storeDir}=fixture(t),delays=[],signals=[];let attempts=0;
 const sink=createDriveSink({token:'mock',state,storeDir,save(){},sleep:async ms=>delays.push(ms),fetchImpl:async(url,init)=>{
  if(url.includes('/upload/') && init.body.includes('retry payload')) {
   signals.push(init.signal);attempts++;
   if(attempts===1){await api.fetchImpl(url,init);throw new DOMException('timeout','TimeoutError');}
   if(attempts===2)throw new DOMException('timeout','TimeoutError');
  }
  return api.fetchImpl(url,init);
 }});
 await sink.append('daily/2026-11-01','2026-11-01','a'.repeat(64),message.ts,'retry payload');
 await sink.finish();
 assert.equal(attempts,3);assert.deepEqual(delays,[1000,2000]);assert.equal(new Set(signals).size,3);
 assert.equal([...api.files.values()].filter(f=>f.name==='2026-11-01').length,1);
 assert.ok(state.uploadHashes['daily/2026-11-01']);
});
test('exhausted upload retries preserve hash and continue other documents; next run resends only failed document',async t=>{
 const {api,state,storeDir}=fixture(t);let failing=true,attempts=0;const delays=[];
 const sink=createDriveSink({token:'mock',state,storeDir,save(){},sleep:async ms=>delays.push(ms),fetchImpl:async(url,init)=>{
  if(url.includes('/upload/') && init.body.includes('failed payload')){attempts++;if(failing)throw new DOMException('timeout','TimeoutError');}
  return api.fetchImpl(url,init);
 }});
 await sink.append('daily/2026-11-01','2026-11-01','a'.repeat(64),message.ts,'failed payload');
 await sink.append('daily/2026-11-02','2026-11-02','b'.repeat(64),message.ts,'other payload');
 await assert.rejects(sink.finish(),/daily\/2026-11-01/);
 assert.equal(attempts,3);assert.deepEqual(delays,[1000,2000]);assert.equal(state.uploadHashes['daily/2026-11-01'],undefined);
 const goodHash=state.uploadHashes['daily/2026-11-02'];assert.ok(goodHash);
 failing=false;await sink.finish();assert.equal(attempts,4);assert.ok(state.uploadHashes['daily/2026-11-01']);assert.equal(state.uploadHashes['daily/2026-11-02'],goodHash);
});
test('daily views split losslessly at 200000, replay unchanged, and clear obsolete parts',async t=>{
 const {api,state,storeDir,make}=fixture(t),sink=make(),key='daily/2026-11-01';
 await sink.append(key,'2026-11-01','a'.repeat(64),message.ts,'😀'.repeat(210000));
 await sink.finish();
 const local=fs.readFileSync(path.join(storeDir,key+'.md'),'utf8');
 const parts=[key,key+'-2',key+'-3'].map(k=>api.files.get(state.files[k]).text);
 assert.equal(parts.join(''),local);for(const part of parts){assert.ok(part.length<=200000);assert.ok(!/[\uD800-\uDBFF]$/.test(part));}
 const writes=api.writes;await sink.finish();assert.equal(api.writes,writes);
 await sink.append(key,'2026-11-01','a'.repeat(64),message.ts,'short');await sink.finish();
 assert.equal(api.files.get(state.files[key+'-2']).text,'\n');assert.equal(api.files.get(state.files[key+'-3']).text,'\n');
});
test('size-aware upload budget and explicit state CLI override',async()=>{
 const {uploadTimeoutMs,splitDaily}=await import('./comms-hub-sync.mjs');
 assert.ok(uploadTimeoutMs('a'.repeat(200000))>uploadTimeoutMs('a'));
 assert.ok(uploadTimeoutMs('あ'.repeat(200000))>uploadTimeoutMs('a'.repeat(200000)));
 assert.ok(uploadTimeoutMs('')>20000);assert.equal(uploadTimeoutMs('a'.repeat(2000000)),300000);
 assert.deepEqual(splitDaily('a'.repeat(200000)),['a'.repeat(200000)]);
 assert.deepEqual(parseArgs(['--live','--state-path','test.json']),{live:true,statePath:'test.json'});
 assert.throws(()=>parseArgs(['--state-path']));assert.deepEqual(parseArgs(['--live']),{live:true});
});

test('Gmail timeout commits each completed message and resumes only pending IDs before next page', async t => {
 const {searchGmail}=await import('./gmail-search.mjs');
 const {state,storeDir,make}=fixture(t), sink=make();
 const controller=new AbortController();
 let resume=false, lists=0; const gets=[];
 const fetchImpl=async(url,init)=>{
  const u=new URL(url);
  if(u.pathname.endsWith('/messages')) {lists++;return Response.json({messages:[{id:'done'},{id:'pending'}],nextPageToken:'next-page'});}
  const id=u.pathname.split('/').at(-1);gets.push(id);
  if(id==='pending'&&!resume) {
   await new Promise((resolve,reject)=>{init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true});});
  }
  return Response.json({id,threadId:id,internalDate:String(Date.parse(message.ts)),payload:{headers:[{name:'Subject',value:message.subject}],mimeType:'text/plain',body:{data:Buffer.from('業務連絡').toString('base64url')}}});
 };
 const commitMessage=async m=>{
  await processPage({source:message.source,page:{messages:[m],cursor:state.sources[message.source].cursor},state,cases,config,sink,live:true});
  if(!resume)controller.abort(new DOMException('source deadline','TimeoutError'));
 };
 const home=makeTestHome(t);
 const ctx={config,home,since:1,until:2000000000000,state:state.sources[message.source],signal:controller.signal,fetchImpl,commitMessage,
  gmailSearch:args=>searchGmail({...args,getToken:async()=> 'mock'})};
 const page=await collectSource(message.source,ctx);
 assert.equal(page.partial,true);assert.deepEqual(page.cursor.pendingIds,['pending']);
 assert.equal(Object.keys(state.sources[message.source].processed).length,1);
 assert.match(fs.readFileSync(path.join(storeDir,'cases/261101ABC.md'),'utf8'),/業務連絡/);
 await processPage({source:message.source,page,state,cases,config,sink,live:true});
 assert.equal(state.sources[message.source].cursor.end,ctx.until);
 resume=true;const before=gets.length;
 const next=await collectSource(message.source,{...ctx,signal:new AbortController().signal,cursor:page.cursor});
 assert.equal(lists,1);assert.deepEqual(gets.slice(before),['pending','pending']);
 assert.deepEqual(next.cursor,{since:1,end:ctx.until,next:'next-page'});
 assert.equal(Object.keys(state.sources[message.source].processed).length,2);
});

test('Gmail metadata filters automated mail and caps concurrent requests at five',async t=>{
 const {searchGmail}=await import('./gmail-search.mjs');let active=0,peak=0;const full=[];
 const home=makeTestHome(t);
 const page=await collectSource('gmail-kim',{config,home,since:1,until:2000000000000,state:{},
  gmailSearch:args=>searchGmail({...args,getToken:async()=> 'mock'}),fetchImpl:async url=>{
   const u=new URL(url);if(u.pathname.endsWith('/messages'))return Response.json({messages:Array.from({length:12},(_,i)=>({id:String(i)}))});
   active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,2));active--;
   const id=u.pathname.split('/').at(-1);if(u.searchParams.get('format')==='full')full.push(id);
   return Response.json({id,internalDate:String(Date.parse(message.ts)),payload:{headers:[{name:'From',value:id==='0'?'noreply@example.test':'staff@example.test'},{name:'Subject',value:message.subject}]}});
  }});
 assert.equal(page.messages.length,12);assert.equal(peak,5);assert.equal(full.length,11);assert.ok(!full.includes('0'));
});

test('process budget skips remaining sources, saves state and reserves publication time with exit zero',async()=>{
 let clock=0,saves=0,finished=0;const visited=[];const state={sources:{},cases:{}};
 const report=await run({live:true},{config,cases,state,clock:()=>clock,save(){saves++;},
  collect:async source=>{visited.push(source);clock=360000;return {messages:[],cursor:{since:1}};},
  sink:{async init(){},async finish(){finished++;assert.equal(clock,360000);clock=480000;throw Object.assign(Error('budget'),{code:'HUB_BUDGET'});}}});
 assert.equal(report.exitCode,0);assert.equal(report.budgetExhausted,true);assert.deepEqual(visited,[SOURCES[0]]);
 assert.equal(finished,1);assert.ok(saves>0);assert.equal(state.sources[SOURCES[0]].cursor.since,1);
 for(const source of SOURCES.slice(1)){assert.match(report.sources[source].skipped,/budget/);assert.ok(state.sources[source].deferredAt);assert.equal(state.sources[source].lastSuccess,undefined);}
 assert.ok(state.publishDeferredAt);
});

test('task registration and Ensure both require a fifteen minute execution limit',()=>{
 const script=fs.readFileSync(new URL('./register-comms-hub-sync.ps1',import.meta.url),'utf8');
 assert.match(script,/ExecutionTimeLimit \(New-TimeSpan -Minutes 15\)/);
 assert.match(script,/\$current.Settings.ExecutionTimeLimit -eq 'PT15M'/);
 assert.match(script,/\$actual.Settings.ExecutionTimeLimit -ne 'PT15M'/);
});

test('run retains Gmail partial progress without claiming full success',async()=>{
 const state={sources:{'gmail-kim':{lastSuccess:'old'}},cases:{}};let savedItems=0;
 const report=await run({live:true},{config,cases,state,save(){savedItems=Math.max(savedItems,Object.keys(state.sources['gmail-kim'].processed||{}).length);},
  collect:async(source,ctx)=>{
   if(source!=='gmail-kim')return {messages:[],cursor:{since:2}};
   await ctx.commitMessage(message);
   assert.equal(savedItems,1,'committed before collector returns');
   return {messages:[message],partial:true,error:'source budget',cursor:{since:1,end:2,pendingIds:['later']}};
  },sink:{async init(){},async append(){},async finish(){}}});
 assert.equal(report.exitCode,0);assert.equal(report.sources['gmail-kim'].accepted,1);assert.equal(report.sources['gmail-kim'].duplicate,0);
 assert.deepEqual(state.sources['gmail-kim'].cursor.pendingIds,['later']);assert.equal(state.sources['gmail-kim'].lastSuccess,'old');assert.equal(state.sources['gmail-kim'].error,'source budget');
});

test('Gmail pending IDs survive commit errors and a reduced page size',async()=>{
 const {searchGmail}=await import('./gmail-search.mjs');
 const page=await searchGmail({user:'mock',query:'',pendingIds:['one','two'],resumeNext:'next',max:1,allowPartial:true,getToken:async()=> 'mock',
  fetchImpl:async()=>Response.json({id:'one'}),onMessage:async()=>{throw Object.assign(Error('destination missing'),{status:404});}});
 assert.equal(page.partial,true);assert.equal(page.skipped,0);assert.deepEqual(page.pendingIds,['one','two']);assert.equal(page.nextPageToken,'next');
});


test('partial publication persists successful hashes and every source cursor on disk', async t => {
 const {api,state,storeDir}=fixture(t), statePath=path.join(storeDir,'state.json');
 const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
 const sink=createDriveSink({token:'mock',state,storeDir,save,sleep:async()=>{},fetchImpl:async(url,init)=>{
  if(url.includes('/upload/') && init.body.includes('bad payload'))throw Error('fetch failed');
  return api.fetchImpl(url,init);
 }});
 await sink.append('daily/2026-11-01','2026-11-01','a'.repeat(64),message.ts,'bad payload');
 await sink.append('daily/2026-11-02','2026-11-02','b'.repeat(64),message.ts,'good payload');
 const report=await run({live:true},{config,cases,state,save,sink,collect:async()=>({messages:[],cursor:{since:123}})});
 const saved=JSON.parse(fs.readFileSync(statePath));
 assert.equal(report.exitCode,0);assert.ok(saved.uploadHashes['daily/2026-11-02']);
 assert.equal(saved.uploadHashes['daily/2026-11-01'],undefined);
 assert.ok(saved.publishErrors.some(e=>e.key==='daily/2026-11-01'));
 for(const source of SOURCES)assert.equal(saved.sources[source].cursor.since,123);
});

test('run lock skips before reading state and recovers dead or expired owners', async t => {
 const {acquireRunLock}=await import('./comms-hub-sync.mjs');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-lock-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'run.lock'), statePath=path.join(dir,'state.json');
 fs.writeFileSync(statePath,'invalid JSON must not be read');
 const release=acquireRunLock(file);const logs=[];
 const result=await run({live:true,statePath},{log:m=>logs.push(m)});
 assert.equal(result.exitCode,0);assert.equal(logs.length,1);assert.ok(fs.existsSync(file));release();
 for(const lock of [{pid:123,startedAt:new Date().toISOString()},{pid:process.pid,startedAt:new Date(Date.now()-21*60000).toISOString()}]){
  fs.writeFileSync(file,JSON.stringify(lock));
  const unlock=acquireRunLock(file,{alive:pid=>pid===process.pid});assert.equal(typeof unlock,'function');unlock();assert.ok(!fs.existsSync(file));
 }
});

test('publication attempts are capped at twenty and unchanged documents do not consume slots',async t=>{
 const {state,make}=fixture(t),sink=make();
 for(let i=1;i<=25;i++)await sink.append(`daily/2026-10-${String(i).padStart(2,'0')}`,String(i),crypto.createHash('sha256').update(String(i)).digest('hex'),message.ts,'payload');
 await sink.finish();assert.equal(sink.publishedDocs,20);assert.equal(sink.deferredDocs,6);
 assert.equal(Object.keys(state.uploadHashes).filter(k=>k.startsWith('daily/')).length,20);
 await sink.finish();assert.equal(sink.publishedDocs,6);assert.equal(sink.deferredDocs,0);
 await sink.finish();assert.equal(sink.publishedDocs,0);
});

test('Drive initialization failure still saves source cursors and exits zero',async()=>{
 const state={sources:{},cases:{}};let saved;
 const report=await run({live:true},{config,cases,state,save(){saved=structuredClone(state);},collect:async()=>({messages:[],cursor:{since:99}}),sink:{async init(){throw Error('fetch failed');}}});
 assert.equal(report.exitCode,0);assert.match(saved.publishErrors[0].reason,/fetch failed/);
 for(const source of SOURCES)assert.equal(saved.sources[source].cursor.since,99);
});

test('line-chat: fetches LINE chats, filters non-business at chat level, ascending sort', async t => {
 const { collectSource } = await import('./comms-hub-sync.mjs');
 const now = Date.now();
 const home=makeTestHome(t);
 const ctx = {
   config, home, since: 0, until: 2000000000000,
   state: {}, beeperToken: 'mock', cases,
   fetchImpl: async url => {
     const u = String(url);
     if (u.includes('/v1/accounts')) return Response.json([
       { accountID: 'line.U9-aaa', network: 'LINE', bridge: { type: 'line' } },
     ]);
     if (u.includes('/v1/chats') && !u.includes('/messages')) return Response.json({ items: [
       { id: '!work:beeper.local', accountID: 'line.U9-aaa', network: 'line', title: 'オージャスト連絡', type: 'single', lastActivity: new Date(now).toISOString() },
       { id: '!social:beeper.local', accountID: 'other', network: 'twitter', title: 'Twitter DM', type: 'single', lastActivity: new Date(now).toISOString() },
     ]});
     if (u.includes('/messages')) {
       // Return newest-first (Beeper API behavior)
       return Response.json({ items: [
         { id: 'm2', senderName: '後スタッフ', text: '確認しました', timestamp: new Date(now - 500).toISOString() },
         { id: 'm1', senderName: '前スタッフ', text: '見積もり作成完了', timestamp: new Date(now - 1000).toISOString() },
       ]});
     }
     return Response.json({});
   }
 };
 const page = await collectSource('line-chat', ctx);
 assert.equal(page.messages.length, 2);
 // Must be sorted ascending by timestamp
 assert.equal(page.messages[0].text, '見積もり作成完了');
 assert.equal(page.messages[1].text, '確認しました');
 assert.equal(page.messages[0].sender, '前スタッフ');
 assert.equal(page.messages[1].sender, '後スタッフ');
});

test('line-chat: paginates backward across pages, stops at sinceMs, returns ascending', async t => {
 const { collectSource } = await import('./comms-hub-sync.mjs');
 const now = Date.now();
 const home=makeTestHome(t);
 const ctx = {
   config, home, since: now - 2000, until: 2000000000000,
   state: {}, beeperToken: 'mock', cases,
   fetchImpl: async url => {
     const u = String(url);
     if (u.includes('/v1/accounts')) return Response.json([{ accountID: 'line.U9-aaa', network: 'LINE' }]);
     if (u.includes('/v1/chats') && !u.includes('/messages')) return Response.json({ items: [
       { id: '!chat', accountID: 'line.U9-aaa', network: 'line', title: 'オージャスト業務', lastActivity: new Date(now).toISOString() },
     ]});
     if (u.includes('/messages')) {
       const hasCursor = u.includes('cursor=');
       if (!hasCursor) {
         // Page 1: newest (timestamps now-100 to now-900)
         return Response.json({
           items: [
             { id: 'm4', senderName: 'D', text: '最新', timestamp: new Date(now - 100).toISOString() },
             { id: 'm3', senderName: 'C', text: '三つ目', timestamp: new Date(now - 500).toISOString() },
             { id: 'm2', senderName: 'B', text: '二つ目', timestamp: new Date(now - 900).toISOString() },
           ],
           hasMore: true, oldestCursor: 'cursor1'
         });
       }
       // Page 2: older (timestamps now-1300, now-1700, now-2100)
       return Response.json({
         items: [
           { id: 'm1', senderName: 'A', text: '一つ目', timestamp: new Date(now - 1300).toISOString() },
           { id: 'm0', senderName: 'Z', text: '範囲外古', timestamp: new Date(now - 2100).toISOString() },
         ],
         hasMore: true, oldestCursor: 'cursor2'
       });
     }
     return Response.json({});
   }
 };
 const page = await collectSource('line-chat', ctx);
 // Should collect m4,m3,m2,m1 then stop (m0 is before sinceMs).
 // After ascending sort: m2(now-900), m1(now-1300) are both before sinceMs(now-2000)? No wait...
 // since = now-2000. m2 is now-900 (after since), m1 is now-1300 (after since). m0 is now-2100 (before since).
 // Collected: m4(now-100), m3(now-500), m2(now-900), m1(now-1300). Stop because oldest on page 2 (m0 at now-2100) < sinceMs(now-2000).
 // Ascending: m1, m2, m3, m4.
 assert.equal(page.messages.length, 4);
 assert.equal(page.messages[0].text, '一つ目');
 assert.equal(page.messages[1].text, '二つ目');
 assert.equal(page.messages[2].text, '三つ目');
 assert.equal(page.messages[3].text, '最新');
 assert.ok(page.messages[0].ts < page.messages[3].ts);
});

test('line-chat: limit reached mid-chat returns resumeTimestamp, next run skips past it', async t => {
 const { collectSource, messageKey } = await import('./comms-hub-sync.mjs');
 const now = Date.now();
 const m1Key = messageKey({ source: 'line-chat', channelId: '!chat1', id: 'm1' });
 const home=makeTestHome(t);
 const ctx = {
   config: { ...config, sourceLimits: { 'line-chat': 2 }, maxPerSource: 2 },
   home, since: 0, until: 2000000000000,
   state: {}, beeperToken: 'mock', cases,
   fetchImpl: async url => {
     const u = String(url);
     if (u.includes('/v1/accounts')) return Response.json([{ accountID: 'line.U9-aaa', network: 'LINE' }]);
     if (u.includes('/v1/chats') && !u.includes('/messages')) return Response.json({ items: [
       { id: '!chat1', accountID: 'line.U9-aaa', network: 'line', title: 'オージャスト業務', lastActivity: new Date(now).toISOString() },
     ]});
     if (u.includes('/messages')) return Response.json({
       items: [
         { id: 'm2', senderName: 'B', text: '二つ目', timestamp: new Date(now - 500).toISOString() },
         { id: 'm1', senderName: 'A', text: '一つ目', timestamp: new Date(now - 1000).toISOString() },
         { id: 'm0', senderName: 'Z', text: '古い', timestamp: new Date(now - 3000).toISOString() },
       ],
       hasMore: false
     });
     return Response.json({});
   }
 };
 const page1 = await collectSource('line-chat', ctx);
 // Collected m0,m1,m2, sorted asc -> m0,m1,m2. Limit 2: take m0,m1, return resumeTimestamp=m1.ts
 assert.equal(page1.messages.length, 2);
 assert.equal(page1.messages[0].text, '古い');
 assert.equal(page1.messages[1].text, '一つ目');
 assert.equal(page1.cursor.chatId, '!chat1');
 assert.ok(page1.cursor.resumeTimestamp);

 // Resume: same chat, m1 is in state.processed (dedup-skips), passes resumeTs (< now-1000),
 // so only m2 is new
 const page2 = await collectSource('line-chat', { ...ctx, cursor: page1.cursor, state: { processed: { [m1Key]: '2026-11-07T00:00:00.000Z' } } });
 assert.equal(page2.messages.length, 1);
 assert.equal(page2.messages[0].text, '二つ目');
 assert.deepEqual(page2.cursor, { since: ctx.until });
});

test('line-chat: non-business chats never call messages API', async t => {
 const { collectSource } = await import('./comms-hub-sync.mjs');
 let messagesCalled = false;
 const home=makeTestHome(t);
 const ctx = {
   config, home, since: 0, until: 2000000000000,
   state: {}, beeperToken: 'mock', cases,
   fetchImpl: async url => {
     const u = String(url);
     if (u.includes('/v1/accounts')) return Response.json([{ accountID: 'line.U9-aaa', network: 'LINE' }]);
     if (u.includes('/v1/chats') && !u.includes('/messages')) return Response.json({ items: [
       { id: '!personal', accountID: 'line.U9-aaa', network: 'line', title: 'プライベート会話', lastActivity: new Date(Date.now()).toISOString() },
       { id: '!work', accountID: 'line.U9-aaa', network: 'line', title: 'オージャスト業務', lastActivity: new Date(Date.now()).toISOString() },
     ]});
     if (u.includes('/messages')) {
       messagesCalled = true;
       return Response.json({ items: [{ id: 'm1', senderName: 'A', text: '業務連絡', timestamp: new Date().toISOString() }] });
     }
     return Response.json({});
   }
 };
 const page = await collectSource('line-chat', ctx);
 // プライベート会話 should be skipped as not-business (not matching businessPatterns)
 // オージャスト matches businessPatterns via norm("オージャスト")
 assert.equal(page.messages.length, 1);
 assert.equal(page.messages[0].text, '業務連絡');
 assert.ok(messagesCalled, 'messages API was called for business chat');
});

test('line-chat: half-width kana title matches business pattern', async t => {
 const { collectSource } = await import('./comms-hub-sync.mjs');
 const home=makeTestHome(t);
 const ctx = {
   config, home, since: 0, until: 2000000000000,
   state: {}, beeperToken: 'mock', cases,
   fetchImpl: async url => {
     const u = String(url);
     if (u.includes('/v1/accounts')) return Response.json([{ accountID: 'line.U9-aaa', network: 'LINE' }]);
     if (u.includes('/v1/chats') && !u.includes('/messages')) return Response.json({ items: [
       { id: '!chat', accountID: 'line.U9-aaa', network: 'line', title: 'ｵｰｼﾞｬｽﾄ業務', lastActivity: new Date(Date.now()).toISOString() },
     ]});
     if (u.includes('/messages')) return Response.json({ items: [{ id: 'm1', senderName: 'A', text: '見積もり', timestamp: new Date().toISOString() }] });
     return Response.json({});
   }
 };
 const page = await collectSource('line-chat', ctx);
 // norm('ｵｰｼﾞｬｽﾄ業務') => 'オージャスト業務' which matches businessPattern 'オージャスト'
 assert.equal(page.messages.length, 1);
 assert.equal(page.messages[0].text, '見積もり');
});

test('line-chat: isDeleted messages are discarded', async t => {
 const { collectSource } = await import('./comms-hub-sync.mjs');
 const home=makeTestHome(t);
 const ctx = {
   config, home, since: 0, until: 2000000000000,
   state: {}, beeperToken: 'mock', cases,
   fetchImpl: async url => {
     const u = String(url);
     if (u.includes('/v1/accounts')) return Response.json([{ accountID: 'line.U9-aaa', network: 'LINE' }]);
     if (u.includes('/v1/chats') && !u.includes('/messages')) return Response.json({ items: [
       { id: '!chat', accountID: 'line.U9-aaa', network: 'line', title: 'オージャスト業務', lastActivity: new Date(Date.now()).toISOString() },
     ]});
     if (u.includes('/messages')) return Response.json({ items: [
       { id: 'm1', senderName: 'A', text: '残るメッセージ', timestamp: new Date(Date.now() - 1000).toISOString() },
       { id: 'm2', senderName: 'B', text: '削除済み', timestamp: new Date(Date.now() - 2000).toISOString(), isDeleted: true },
       { id: 'm3', senderName: 'C', text: 'これも残る', timestamp: new Date(Date.now() - 3000).toISOString() },
     ]});
     return Response.json({});
   }
 };
 const page = await collectSource('line-chat', ctx);
 assert.equal(page.messages.length, 2);
 assert.equal(page.messages[0].text, 'これも残る');
 assert.equal(page.messages[1].text, '残るメッセージ');
 assert.ok(!page.messages.some(m => m.id === 'm2'));
});

test('line-chat: exclusion rules apply through processPage', async t => {
 const state = { sources: { 'line-chat': {} }, cases: {} };
 const msg = { source: 'line-chat', id: 'm1', channelId: '!chat:beeper.local', chat: '仕事', ts: message.ts, sender: 'Staff', text: '見積もりです', url: null };
 const r1 = await processPage({ source: 'line-chat', page: { messages: [msg], cursor: {} }, state, cases, config, live: false, sink: {} });
 assert.equal(r1.accepted, 1);
 const r2 = await processPage({ source: 'line-chat', page: { messages: [{ ...msg, id: 'm2', text: '診療予約の件' }], cursor: {} }, state, cases, config, live: false, sink: {} });
 assert.equal(r2.excluded, 1);
 const r3 = await processPage({ source: 'line-chat', page: { messages: [{ ...msg, id: 'm3', text: 'こんにちは' }], cursor: {} }, state, cases, config, live: false, sink: {} });
 assert.equal(r3.excluded, 1);
 const r4 = await processPage({ source: 'line-chat', page: { messages: [{ ...msg, id: 'm4', chat: '濱川様✖️オージャスト', text: '本日のご連絡' }], cursor: {} }, state, cases, config, live: false, sink: {} });
 assert.equal(r4.accepted, 1);
});

test('line-chat: Beeper unavailable error does not affect other sources', async t => {
 const state = { sources: {}, cases: {} };
 const report = await run({ live: true }, {
   config, cases, state, save() {},
   sink: { createdDocs: 0, async init() {}, async append() {}, async finish() { return {}; } },
   collect: async source => {
     if (source === 'line-chat') throw Object.assign(new Error('Beeper Desktop API unavailable'), { status: 0 });
     return { messages: [], cursor: { since: 99 } };
   }
 });
 assert.equal(report.exitCode, 0);
 assert.match(report.sources['line-chat'].error, /Beeper Desktop API unavailable/);
 assert.ok(!report.sources['gmail-kim'].error);
});

test('line-chat: render shows LINE(Beeper) for url-less messages', async t => {
 const { render } = await import('./comms-hub-sync.mjs');
 const lineChat = render({ source: 'line-chat', ts: '2026-11-07T00:00:00.000Z', sender: 'A', text: 'こんにちは', chat: '仕事', url: null });
 assert.match(lineChat, /LINE（Beeper）: 仕事/);
 const line = render({ source: 'line', ts: '2026-11-07T00:00:00.000Z', sender: 'A', text: '通知', url: null });
 assert.match(line, /元リンクなし（通知保存データ）/);
});

test('line-chat: excluded chats logged to local file as object keyed by id', async t => {
 const os = await import('node:os');
 const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-linechat-excl-'));
 t.after(() => fs.rmSync(home, { recursive: true, force: true }));
 const { collectSource } = await import('./comms-hub-sync.mjs');
 const ctx = {
   config: { ...config, lineChatExclude: ['プライベート', 'AI情報'] },
   home, since: 0, until: 2000000000000,
   state: {}, beeperToken: 'mock', cases,
   fetchImpl: async url => {
     const u = String(url);
     if (u.includes('/v1/accounts')) return Response.json([{ accountID: 'line.U9-aaa', network: 'LINE', bridge: { type: 'line' } }]);
     if (u.includes('/v1/chats') && !u.includes('/messages')) return Response.json({ items: [
       { id: '!a:beeper.local', accountID: 'line.U9-aaa', network: 'line', title: 'プライベート', type: 'single', lastActivity: new Date(Date.now()).toISOString() },
       { id: '!b:beeper.local', accountID: 'line.U9-aaa', network: 'line', title: '仕事', type: 'single', lastActivity: new Date(Date.now()).toISOString() },
     ]});
     if (u.includes('/messages')) return Response.json({ items: [{ id: 'm1', timestamp: new Date().toISOString(), senderName: 'A', text: '業務' }] });
     return Response.json({});
   }
 };
 await collectSource('line-chat', ctx);
 const logPath = path.join(home, '.claude', 'comms-hub', 'line-chat-excluded.json');
 assert.ok(fs.existsSync(logPath));
 const log = JSON.parse(fs.readFileSync(logPath, 'utf8'));
 // Now keyed by chat id, not array indexed
 assert.ok(log['!a:beeper.local']);
 assert.equal(log['!a:beeper.local'].title, 'プライベート');
 assert.equal(log['!a:beeper.local'].reason, 'config-exclude');
 // "仕事" is not-business, should also be logged
 assert.ok(log['!b:beeper.local']);
 assert.equal(log['!b:beeper.local'].reason, 'not-business');
});

test('line-chat: messages with attachments appends attachment info', async t => {
 const { collectSource } = await import('./comms-hub-sync.mjs');
 const home=makeTestHome(t);
 const ctx = {
   config, home, since: 0, until: 2000000000000,
   state: {}, beeperToken: 'mock', cases,
   fetchImpl: async url => {
     const u = String(url);
     if (u.includes('/v1/accounts')) return Response.json([{ accountID: 'line.U9-aaa', network: 'LINE', bridge: { type: 'line' } }]);
     if (u.includes('/v1/chats') && !u.includes('/messages')) return Response.json({ items: [
       { id: '!a:beeper.local', accountID: 'line.U9-aaa', network: 'line', title: 'オージャスト業務', lastActivity: new Date(Date.now()).toISOString() },
     ]});
     if (u.includes('/messages')) return Response.json({ items: [
       { id: 'm2', senderName: 'Sender', text: '', timestamp: new Date(Date.now() - 500).toISOString(),
         attachments: [{ type: 'image', file_name: 'stamp.png' }] },
       { id: 'm1', senderName: 'Sender', text: '本文', timestamp: new Date(Date.now() - 1000).toISOString(),
         attachments: [{ type: 'image', file_name: 'photo.jpg' }, { type: 'file', file_name: 'document.pdf' }] },
     ]});
     return Response.json({});
   }
 };
 const page = await collectSource('line-chat', ctx);
 assert.equal(page.messages.length, 2);
 // Ascending: m1 first (now-1000)
 assert.match(page.messages[0].text, /\[添付: image photo.jpg\]/);
 assert.match(page.messages[0].text, /\[添付: file document.pdf\]/);
 assert.match(page.messages[1].text, /\[添付: image stamp.png\]/);
});

test('line-chat: (g) state.processed with messageKey skips already-processed messages', async t => {
 const { collectSource, messageKey } = await import('./comms-hub-sync.mjs');
 const now = Date.now();
 const m1Key = messageKey({ source: 'line-chat', channelId: '!a:beeper.local', id: 'm1' });
 const home=makeTestHome(t);
 const ctx = {
   config, home, since: 0, until: 2000000000000,
   state: { processed: { [m1Key]: '2026-11-07T00:00:00.000Z' } },
   beeperToken: 'mock', cases,
   fetchImpl: async url => {
     const u = String(url);
     if (u.includes('/v1/accounts')) return Response.json([{ accountID: 'line.U9-aaa', network: 'LINE' }]);
     if (u.includes('/v1/chats') && !u.includes('/messages')) return Response.json({ items: [
       { id: '!a:beeper.local', accountID: 'line.U9-aaa', network: 'line', title: 'オージャスト業務', lastActivity: new Date(now + 1000).toISOString() },
     ]});
     if (u.includes('/messages')) return Response.json({ items: [
       { id: 'm1', senderName: 'A', text: '既に処理済み', timestamp: new Date(now + 10).toISOString() },
       { id: 'm2', senderName: 'B', text: '新しいメッセージ', timestamp: new Date(now + 20).toISOString() },
     ]});
     return Response.json({});
   }
 };
 const page = await collectSource('line-chat', ctx);
 assert.equal(page.messages.length, 1);
 assert.equal(page.messages[0].id, 'm2');
 assert.equal(page.messages[0].text, '新しいメッセージ');
});

test('line-chat: (h) early-return cursor includes end, subsequent calls use saved end', async t => {
 const { collectSource } = await import('./comms-hub-sync.mjs');
 const now = Date.now();
 const until = now + 100000;
 let msgCalls = 0;
 const home=makeTestHome(t);
 const ctxBase = {
   config: { ...config, sourceLimits: { 'line-chat': 2 } },
   home, since: 0, until,
   state: {}, beeperToken: 'mock', cases,
   fetchImpl: async url => {
     const u = String(url);
     if (u.includes('/v1/accounts')) return Response.json([{ accountID: 'line.U9-aaa', network: 'LINE' }]);
     if (u.includes('/v1/chats') && !u.includes('/messages')) return Response.json({ items: [
       { id: '!a:beeper.local', accountID: 'line.U9-aaa', network: 'line', title: 'オージャスト業務', lastActivity: new Date(now + 1000).toISOString() },
     ]});
     if (u.includes('/messages')) {
       msgCalls++;
       return Response.json({ items: [
         { id: 'm1', senderName: 'A', text: 'a', timestamp: new Date(now + 10).toISOString() },
         { id: 'm2', senderName: 'A', text: 'b', timestamp: new Date(now + 20).toISOString() },
         { id: 'm3', senderName: 'B', text: 'c', timestamp: new Date(now + 30).toISOString() },
       ]});
     }
     return Response.json({});
   }
 };
 // First call: limit 2, get m1 and m2, cursor has end
 const page1 = await collectSource('line-chat', ctxBase);
 assert.equal(page1.messages.length, 2);
 assert.equal(page1.cursor.end, until);
 assert.equal(page1.cursor.chatId, '!a:beeper.local');
 assert.ok(page1.cursor.resumeTimestamp);

 // Second call with cursor: m1 skipped (resumeTs < now+20), m2 skipped (resumeTs < now+20 is false
 // but m2 is at resumeTs so < check passes; not in processed, so included), m3 included
 // With 2 messages (m2,m3) and limit 2 → hits limit again, returns cursor
 const page2 = await collectSource('line-chat', { ...ctxBase, cursor: page1.cursor });
 assert.equal(page2.messages.length, 2);
 assert.equal(page2.cursor.end, until);
 assert.equal(page2.cursor.chatId, '!a:beeper.local');

 // Third call: m1,m2 skipped by resumeTs (< now+30), m3 passes < and included
 // Only 1 message, no limit hit → returns { since: end }
 const page3 = await collectSource('line-chat', { ...ctxBase, cursor: page2.cursor });
 assert.equal(page3.messages.length, 1);
 assert.equal(page3.messages[0].id, 'm3');
 assert.deepEqual(page3.cursor, { since: page2.cursor.end });
});

test('line-chat: (i) same-timestamp messages not lost with < comparison, dedup handles processed', async t => {
 const { collectSource, messageKey } = await import('./comms-hub-sync.mjs');
 const now = Date.now();
 const ts = new Date(now + 10).toISOString();
 const processedKey = messageKey({ source: 'line-chat', channelId: '!a:beeper.local', id: 'm1' });
 const home=makeTestHome(t);
 const ctx = {
   config, home, since: 0, until: 2000000000000,
   state: { processed: { [processedKey]: '2026-11-07T00:00:00.000Z' } },
   beeperToken: 'mock', cases,
   cursor: { chatId: '!a:beeper.local', resumeTimestamp: ts },
   fetchImpl: async url => {
     const u = String(url);
     if (u.includes('/v1/accounts')) return Response.json([{ accountID: 'line.U9-aaa', network: 'LINE' }]);
     if (u.includes('/v1/chats') && !u.includes('/messages')) return Response.json({ items: [
       { id: '!a:beeper.local', accountID: 'line.U9-aaa', network: 'line', title: 'オージャスト業務', lastActivity: new Date(now + 1000).toISOString() },
     ]});
     if (u.includes('/messages')) return Response.json({ items: [
       { id: 'm1', senderName: 'A', text: '既に処理済み（同タイムスタンプ）', timestamp: ts },
       { id: 'm2', senderName: 'B', text: '未処理（同タイムスタンプ）', timestamp: ts },
     ]});
     return Response.json({});
   }
 };
 // With < comparison, neither message is skipped by resumeTs.
 // m1 is skipped by state.processed dedup, m2 is included.
 const page = await collectSource('line-chat', ctx);
 assert.equal(page.messages.length, 1);
 assert.equal(page.messages[0].id, 'm2');
 assert.equal(page.messages[0].text, '未処理（同タイムスタンプ）');
});

test('last-run.json: live run writes file with phases and source names, no tokens', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lastrun-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const statePath = path.join(tmp, 'state.json');
  const sink = { createdDocs: 0, publishedDocs: 0, deferredDocs: 0, async init() {}, async append() {}, async finish() { return {}; } };
  const report = await run({ live: true, statePath }, {
    config, cases,
    state: { sources: {}, cases: {} },
    save() {},
    sink,
    suppressWatchdog: true,
    collect: async source => ({ messages: [], cursor: { since: 99 } }),
  });
  const lrPath = path.join(tmp, 'last-run.json');
  assert.ok(fs.existsSync(lrPath), 'last-run.json should exist');
  const lr = JSON.parse(fs.readFileSync(lrPath, 'utf8'));
  assert.equal(lr.mode, 'live');
  assert.equal(lr.exitCode, 0);
  assert.ok(lr.startedAt);
  assert.ok(lr.finishedAt);
  assert.ok(typeof lr.elapsedMs === 'number' && lr.elapsedMs >= 0);
  assert.ok(Array.isArray(lr.phases));
  // Each source name should appear in phases
  for (const s of SOURCES) assert.ok(lr.phases.some(p => p.name === `collect:${s}`), `phase for ${s} missing`);
  assert.ok(lr.phases.some(p => p.name === 'publish'), 'publish phase missing');
  assert.ok(lr.phases.every(p => p.startedAt && p.finishedAt), 'all phases have start/finish');
  // No tokens, emails, or message bodies
  const raw = fs.readFileSync(lrPath, 'utf8');
  assert.ok(!raw.includes('mock'), 'no token string');
  assert.ok(!raw.includes('@'), 'no email addresses');
  assert.ok(!raw.includes('業務連絡'), 'no message bodies');
  // JSONL file exists and has at least one entry
  const jsonlPath = path.join(tmp, 'last-runs.jsonl');
  assert.ok(fs.existsSync(jsonlPath));
  const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.mode, 'live');
  assert.equal(parsed.exitCode, 0);
});

test('last-run.json: error in run still writes last-run.json with error (via sink failure)', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lastrun-err-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const statePath = path.join(tmp, 'state.json');
  // Make sink.finish throw an unexpected error inside runLocked
  const sink = {
    createdDocs: 0, publishedDocs: 0, deferredDocs: 0,
    async init() {},
    async append() {},
    async finish() { throw new Error('Drive API HTTP 500 something-went-wrong'); }
  };
  const report = await run({ live: true, statePath }, {
    config, cases,
    state: { sources: {}, cases: {} },
    save() {},
    sink,
    suppressWatchdog: true,
    collect: async source => ({ messages: [], cursor: { since: 99 } }),
  });
  const lrPath = path.join(tmp, 'last-run.json');
  assert.ok(fs.existsSync(lrPath));
  const lr = JSON.parse(fs.readFileSync(lrPath, 'utf8'));
  assert.equal(lr.mode, 'live');
  assert.ok(lr.publishError);
  assert.match(String(lr.publishError), /something-went-wrong/);
  // JSONL also has the error entry
  const jsonlPath = path.join(tmp, 'last-runs.jsonl');
  assert.ok(fs.existsSync(jsonlPath));
  const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /something-went-wrong/);
});

test('last-run.json: no token/body in error run output', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-lastrun-nosec-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const statePath = path.join(tmp, 'state.json');
  const phases = [];
  const tracker = createPhaseTracker(phases);
  tracker.start('test-phase');
  tracker.end();
  const report = { mode: 'live', sources: {}, exitCode: 1 };
  writeLastRun(statePath, report, { error: 'something failed', phases, clock: Date.now() });
  const raw = fs.readFileSync(path.join(tmp, 'last-run.json'), 'utf8');
  assert.ok(!raw.includes('@'));
  assert.match(raw, /something failed/);
  const jsonlRaw = fs.readFileSync(path.join(tmp, 'last-runs.jsonl'), 'utf8');
  assert.match(jsonlRaw, /something failed/);
});

test('last-runs.jsonl: caps at 20 entries', async t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-jsonl-cap-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const statePath = path.join(tmp, 'state.json');
  const timestamps = [];
  for (let i = 0; i < 25; i++) {
    const ts = new Date(Date.now() + i * 1000).toISOString();
    timestamps.push({ startedAt: ts, clock: Date.now() + i * 1000 });
    writeLastRun(statePath, { mode: 'live', sources: {}, exitCode: 0, _startedAt: ts }, { clock: timestamps[i].clock });
  }
  const jsonlPath = path.join(tmp, 'last-runs.jsonl');
  const lines = fs.readFileSync(jsonlPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(lines.length, 20, 'should have exactly 20 lines');
  const parsed = lines.map(l => JSON.parse(l));
  assert.ok(parsed.every(e => e.mode === 'live'));
  assert.equal(parsed.length, new Set(parsed.map(e => e.startedAt)).size, 'all entries should have unique startedAt');
  // The kept lines should be the last 20 of 25, i.e. entries 5 through 24
  assert.equal(parsed[0].startedAt, timestamps[5].startedAt, 'first kept entry should be the 6th written');
  assert.equal(parsed[19].startedAt, timestamps[24].startedAt, 'last kept entry should be the 25th written');
});

test('regression: repo .claude/comms-hub/line-chat-excluded.json is never modified by tests', async t => {
  const repoExcludedPath = path.join(new URL('..', import.meta.url).pathname, '.claude', 'comms-hub', 'line-chat-excluded.json');
  // Read content before any test (the `after` hook on the last-run.json test may have run;
  // this test runs in parallel, but we compare contents deterministically — any in-test write
  // to this path would have produced a git-dirty state or test pollution.)
  const before = (() => { try { return fs.readFileSync(repoExcludedPath, 'utf8'); } catch { return null; } })();
  t.after(() => {
    const after = (() => { try { return fs.readFileSync(repoExcludedPath, 'utf8'); } catch { return null; } })();
    assert.equal(after, before, 'repo line-chat-excluded.json should not change: tests must use a temp home');
  });
});
