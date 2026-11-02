import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { matchCase, exclusion, processPage, run, SOURCES, createDriveSink, parseArgs } from './comms-hub-sync.mjs';
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
  const files = new Map(); let seq=0, writes=0, failAfterInsert=false;
  const json = (x, status=200) => new Response(JSON.stringify(x), {status,headers:{'Content-Type':'application/json'}});
  const fetchImpl = async (url, init={}) => {
    const u = new URL(url), method=init.method || 'GET';
    if (u.pathname.includes('/permissions')) return json(method==='GET'?{permissions:[]}:{id:'permission'});
    if (u.hostname==='docs.googleapis.com') {
      const id=u.pathname.split('/').at(-1).split(':')[0], f=files.get(id);
      if (method==='GET') return json({revisionId:'rev',body:{content:[{endIndex:f.text.length+1,paragraph:{elements:[{textRun:{content:f.text}}]}}]}});
      const b=JSON.parse(init.body);
      for(const r of b.requests) {
        if(r.deleteContentRange) f.text='\n';
        if(r.insertText) {const i=r.insertText.location.index-1; f.text=f.text.slice(0,i)+r.insertText.text+f.text.slice(i); writes++;}
      }
      if(failAfterInsert) {failAfterInsert=false; throw new Error('response lost');}
      return json({});
    }
    if(method==='GET' && u.pathname.endsWith('/files')) return json({files:[]});
    if(method==='POST') {
      const id=`doc${++seq}`; files.set(id,{text:'\n'}); return json({id});
    }
    throw new Error('unexpected mock route '+url);
  };
  return {fetchImpl,files,get writes(){return writes;}, loseNext(){failAfterInsert=true;}};
}
test('Docs API mock: retries after lost response, source-separated IDs, late arrivals sorted', async () => {
  const api=mockDrive(), state={sources:{'gmail-kim':{},'gmail-seisaku':{}},cases:{},files:{daily:'daily',cases:'cases'}};
  const sink=createDriveSink({token:'mock',state,save(){},fetchImpl:api.fetchImpl});
  const args={source:message.source,page:{messages:[message],cursor:{since:5}},state,cases,config,sink,live:true};
  api.loseNext(); await assert.rejects(processPage(args),/response lost/);
  assert.equal(state.sources['gmail-kim'].cursor,undefined);
  await processPage(args); const writes=api.writes;
  await processPage(args); assert.equal(api.writes,writes);
  await processPage({...args,source:'gmail-seisaku',page:{messages:[{...message,source:'gmail-seisaku'}],cursor:{since:5}}});
  assert.equal(api.writes,writes+2);
  await processPage({...args,page:{messages:[{...message,id:'old',ts:'2026-11-01T01:00:00.000Z'}],cursor:{since:6}}});
  const daily=api.files.get(state.files['daily/2026-11-01']).text;
  const caseText=api.files.get(state.files['cases/261101ABC']).text;
  assert.ok(daily.indexOf('01:00:00.000Z') < daily.indexOf('02:00:00.000Z'));
  assert.ok(caseText.indexOf('02:00:00.000Z') < caseText.indexOf('01:00:00.000Z'));
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
test('Gmail pagination preserves original upper boundary and account', async () => {
  const {collectSource}=await import('./comms-hub-sync.mjs');
  const ctx={config,home:'.',since:100000,until:300000,cursor:{end:200000,next:'p1'},state:{},gmailSearch:async args=>{
    assert.equal(args.user,config.mailboxes['gmail-seisaku']); assert.equal(args.pageToken,'p1'); assert.match(args.query,/before:201/);
    return {messages:[],nextPageToken:'p2'};
  }};
  assert.deepEqual((await collectSource('gmail-seisaku',ctx)).cursor,{since:100000,end:200000,next:'p2'});
});
test('Discord resumes a full page even when legacy truncated flag is false', async()=>{
  const {collectSource}=await import('./comms-hub-sync.mjs');
  const ctx={config:{...config,maxPerSource:1},home:'.',since:0,until:Date.now(),state:{},discordToken:'mock',listChannels:async()=>[{id:'a',type:0,name:'work'}],discordFetch:async()=>({truncated:false,messages:[{id:'m',timestamp:message.ts,content:'見積',author:{username:'staff'}}]})};
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
 assert.equal(report.exitCode,1);assert.equal(report.createdDocs,2);assert.equal(report.rootId,'root');
 assert.equal(Object.keys(report.sources).length,6);assert.match(state.publishError,/SERVICE_DISABLED/);
});
