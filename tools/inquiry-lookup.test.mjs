import { readHookSettings } from './fixtures/read-hook-settings.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { lookup, markdown, parseArgs, gmailQuery } from './inquiry-lookup.mjs';
import { readSheet, searchRows, INQUIRY_SHEET, INQUIRY_TAB, CASES_SHEET, xlsxRows, matchMeetingInquiries } from './lib/inquiry-sheet.mjs';
import { routeMailbox } from './lib/mail-groups.mjs';
import { getDriveToken } from './lib/drive-auth.mjs';
import { gwsFetch } from './lib/gws-proxy.mjs';
import { searchGmail } from './gmail-search.mjs';
import { inquiryContext } from './inquiry-lookup-hint.mjs';
import { collectSource, processPage, SOURCES, messageKey, matchCase } from './comms-hub-sync.mjs';
import { buildLocalInput, renderPrompt, loadLocalContext } from './meeting-prep-dispatch.mjs';
const headers = ['問い合わせ日時','お名前','メールアドレス','電話番号','お問い合わせ内容','会社名','送信確認','メールアドレス','きっかけ','キーワード','プライバシー','','対応状況','備考','年','月','営業担当','応募者対応チーム'];
const row = ['2026/10/30 9:42','磯村晶子','','03-0000-0000','社員総会\n2027/5/28 TAKANAWA GATEWAY\n' + '全文'.repeat(2500),'株式会社ファブリカ','','akiko@fabrica.test','','','','','新規','','2026','10','担当者',''];
const values = [headers, row];
const now = Date.parse('2026-11-04T00:00:00Z');
const noNetwork = async () => { throw Error('認証未設定'); };
// Minimal multi-tab XLSX fixture, including sparse rows and shared/inline strings.
function archive(files) {
  const locals = [], central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const n = Buffer.from(name), body = Buffer.from(text), local = Buffer.alloc(30), dir = Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50); local.writeUInt32LE(body.length,18); local.writeUInt32LE(body.length,22); local.writeUInt16LE(n.length,26);
    dir.writeUInt32LE(0x02014b50); dir.writeUInt32LE(body.length,20); dir.writeUInt32LE(body.length,24); dir.writeUInt16LE(n.length,28); dir.writeUInt32LE(offset,42);
    locals.push(local,n,body); central.push(dir,n); offset += local.length+n.length+body.length;
  }
  const end = Buffer.alloc(22), cd=Buffer.concat(central);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length/2,8); end.writeUInt16LE(central.length/2,10); end.writeUInt32LE(cd.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...locals,cd,end]);
}
function workbook(tab=INQUIRY_TAB) {
  return archive({
    'xl/workbook.xml': `<workbook><sheets><sheet name="別タブ" sheetId="1" r:id="rId1"/><sheet name="${tab}" sheetId="2" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>',
    'xl/sharedStrings.xml': '<sst><si><t>会社名</t></si><si><r><t>ファブ</t></r><r><t>リカ</t></r></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>wrong tab</t></is></c></row></sheetData></worksheet>',
    'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="F1" t="s"><v>0</v></c></row><row r="3119"><c r="A3119"><v>46325.4041666667</v></c><c r="E3119" t="inlineStr"><is><t>社員総会&#10;TAKANAWA &amp; GATEWAY</t></is></c><c r="F3119" t="s"><v>1</v></c><c r="AA3119" t="inlineStr"><is><t>追加列</t></is></c></row></sheetData></worksheet>',
  });
}
test('全行検索は3119行目・重複列名・空列・内容全文・元リンクを保持する', () => {
  const all = [headers, ...Array.from({length:3117},()=>[]), row];
  for (const terms of [['ファブリカ'],['磯村'],['FABRICA.TEST'],['該当なし','ｆａｂｒｉｃａ']]) {
    const [hit] = searchRows(all,terms); assert.equal(hit.row,3119); assert.equal(hit.columns.length,18);
    assert.equal(hit.excerpt,row[4]); assert.equal(hit.date,'2026-10-30T00:42:00.000Z'); assert.match(decodeURIComponent(hit.url),/A3119:R3119/);
    assert.equal(hit.columns[2].name, hit.columns[7].name); assert.equal(hit.columns[11].value,'');
  }
  assert.deepEqual(searchRows(all,[]),[]);
});
test('XLSX fallback selects named tab, decodes strings and preserves sparse row numbers and extra columns', () => {
  const rows = xlsxRows(workbook(),INQUIRY_TAB);
  assert.equal(rows.length,3119); assert.deepEqual(rows[1],[]); assert.equal(rows[3118][5],'ファブリカ');
  assert.equal(rows[3118][4],'社員総会\nTAKANAWA & GATEWAY'); assert.equal(rows[3118][26],'追加列');
  assert.throws(()=>xlsxRows(workbook(),'ないタブ'),/未確認/);
});
test('known group users redirect before authentication, query OR remains parenthesized', async () => {
  for (const name of ['satou','eigyou','assing','web23','saiyo','info']) assert.equal(routeMailbox(`${name}@orgiast.jp`).user,'seisaku-team@orgiast.jp');
  let query;
  const result = await searchGmail({user:' SATOU@ORGIAST.JP ', query:'from:a OR from:b', getToken: async o => {assert.equal(o.impersonate,'seisaku-team@orgiast.jp');return 'token';}, fetchImpl: async url => {query = new URL(url).searchParams.get('q');return Response.json({messages:[]});}});
  assert.equal(query,'to:satou@orgiast.jp (from:a OR from:b)'); assert.match(result.notice,/切り替え/);
  assert.equal(routeMailbox('kim@orgiast.jp','query').user,'kim@orgiast.jp');
});
test('unknown unauthorized_client explains group possibility without claiming a permission error',async()=>{
  await assert.rejects(searchGmail({user:'unknown@orgiast.jp',query:'test',getToken:async()=>{throw Error('unauthorized_client');}}),/グループの可能性.*seisaku-team@orgiast.jp.*to:unknown@orgiast.jp/);
});
test('unavailable credentials produce source-specific 未確認 and no false absence',async()=>{
  const result = await lookup(['ファブリカ'],{now,home:'/nonexistent',getToken:noNetwork,fetchImpl:noNetwork});
  assert.equal(Object.keys(result.sources).length,6); assert.equal(result.complete,false);
  assert.ok(Object.values(result.sources).every(s=>s.status==='未確認'));
  assert.match(markdown(result),/未確認の情報源があるため/);
});
test('keyless PC uses actual drive-auth/gws-proxy for Gmail and named worksheet export, kim stays unconfirmed',async()=>{
  const requests=[];
  const getToken = opts => getDriveToken({...opts,keyPath:path.join(os.tmpdir(),'inquiry-no-such-key.json')});
  const request = async (route,opts) => {
    assert.equal(route,'gws'); requests.push(opts.query);
    const {service,path:routePath}=opts.query; let body;
    if (service==='drive' && routePath.includes('/export?')) body=workbook(routePath.includes(CASES_SHEET)?'案件一覧':INQUIRY_TAB);
    else if(service==='gmail') body=Buffer.from(JSON.stringify({messages:[]}));
    else body=Buffer.from(JSON.stringify({files:[]}));
    return {status:200,body:body.toString('base64')};
  };
  const fetchImpl=(url,opts)=>gwsFetch(url,opts,{request});
  const result=await lookup(['ファブリカ'],{now,home:'/nonexistent',getToken,fetchImpl});
  assert.equal(result.sources['inquiry-sheet'].status,'確認済み'); assert.equal(result.hits.find(h=>h.source==='inquiry-sheet').row,3119);
  assert.equal(result.sources['gmail:seisaku-team@orgiast.jp'].status,'確認済み');
  assert.equal(result.sources['gmail:kim@orgiast.jp'].status,'未確認');assert.equal(result.sources['calendar:kim@orgiast.jp'].status,'未確認');
  assert.ok(requests.some(q=>q.service==='gmail'));assert.ok(requests.some(q=>q.path.includes('/export?')));
  const rows=await readSheet(INQUIRY_SHEET,INQUIRY_TAB,{getToken,fetchImpl});assert.match(rows[3118][0],/^2026-10-30T00:42:/);
});
test('DWD lookup paginates Gmail and calendar, searches all sources, returns ascending timestamps',async()=>{
  const queries=[];
  const result=await lookup(['ファブリカ'],{now,home:'/nonexistent',getToken:async()=> 'token',sheetReader:async()=>values,
    gmailSearch:async o=>{queries.push(o);return {messages:[{internalDate:String(now-(o.pageToken?2:1)*86400000),threadId:o.pageToken||'first',subject:'ファブリカ',snippet:'メール'}],nextPageToken:o.pageToken?null:'page2'};},
    fetchImpl:async url=>{
      const u=new URL(url);
      if(u.pathname.includes('/calendar/')){assert.ok(u.searchParams.has('timeMin'));return Response.json({items:[{summary:'ファブリカ',start:{dateTime:'2026-11-05T09:00:00+09:00'},htmlLink:'https://calendar.google.com/event'}],...(u.searchParams.has('pageToken')?{}:{nextPageToken:'cal2'})});}
      if(u.searchParams.get('alt')==='media')return Response.json({cases:{C1234:{name:'ファブリカ',updatedAt:'2026-10-31T00:00:00Z',docId:'doc'}},sources:{'inquiry-sheet':{lastSuccess:'2026-11-04'}}});
      return Response.json({files:[{id:u.searchParams.get('q').includes('index.json')?'index':'root'}]});
    }});
  assert.equal(result.complete,true);assert.equal(queries.length,4);assert.ok(queries.every(q=>q.query.includes('newer_than:90d')));
  assert.equal(result.hits.length,9);assert.equal(result.hits[0].date,'2026-10-30T00:42:00.000Z');assert.match(result.notices.join(' '),/lastSuccess/);
});
for(const prompt of ['株式会社ファブリカの問い合わせを確認','磯村様との打ち合わせを準備','今日9時の問い合わせの準備をして'])test(`hint fires: ${prompt}`,()=>assert.match(inquiryContext({prompt}),/inquiry-lookup.mjs.*\n.*seisaku-team@/));
for(const prompt of ['問い合わせ検索ツールのテストを書いて','株式会社ファブリカのロゴを変更','明日は晴れですか'])test(`hint silent: ${prompt}`,()=>assert.equal(inquiryContext({prompt}),''));
test('hub source filters excluded sales/status, routes unique company or unassigned, deduplicates and resumes',async()=>{
  const excluded=[...row];excluded[12]='完了（除外）';
  const excludedSales=[...row];excludedSales[16]='対象外';
  const unknown=[...row];unknown[5]='未知の会社';
  const ctx={config:{maxPerSource:10},since:now-14*86400000,until:now,state:{},sheetReader:async()=>[headers,row,excluded,excludedSales,unknown]};
  const page=await collectSource('inquiry-sheet',ctx);assert.equal(page.messages.length,4);
  const state={sources:{'inquiry-sheet':{}},cases:{}};const appended=[];
  const args={source:'inquiry-sheet',page,state,cases:[{id:'C1234',client:'ファブリカ',name:'社員総会'}],config:{},live:true,sink:{append:async(...a)=>{appended.push(a);return'doc';}}};
  const report=await processPage(args);assert.equal(report.accepted,2);assert.equal(report.excluded,2);
  assert.ok(appended.some(a=>a[0]==='cases/C1234' && a[4].includes('TAKANAWA')));assert.ok(appended.some(a=>a[0].startsWith('unassigned/')));
  assert.equal((await processPage(args)).duplicate,4);
  assert.equal((await collectSource('inquiry-sheet',{...ctx,state:state.sources['inquiry-sheet']})).messages.length,0);
  assert.equal(matchCase(page.messages[0],[{id:'one',client:'ファブリカ'},{id:'two',client:'株式会社ファブリカ'}],{}),null);
  const first=await collectSource('inquiry-sheet',{...ctx,config:{maxPerSource:1}});assert.equal(first.partial,true);assert.equal(first.cursor.since,ctx.since);
  assert.ok(SOURCES.includes('inquiry-sheet'));assert.ok(state.sources['inquiry-sheet'].processed[messageKey(page.messages[0])]);
});
test('meeting prep matches exact external domain or company, rejects public/internal domain and prioritizes full inquiry',()=>{
  const job={case:{client:'別会社'},event:{attendees:[{email:'person@fabrica.test'}]},route:{}};
  assert.equal(matchMeetingInquiries(values,job).length,1);
  assert.equal(matchMeetingInquiries(values,{case:{client:'ファブリカ'}}).length,1);
  assert.equal(matchMeetingInquiries(values,{event:{attendees:[{email:'person@evilfabrica.test'}]}}).length,0);
  const personal=[...row];personal[7]='x@gmail.com';assert.equal(matchMeetingInquiries([headers,personal],{event:{attendees:[{email:'other@gmail.com'}]}}).length,0);
  const inquiries=matchMeetingInquiries(values,job);
  const {prompt}=buildLocalInput({jobs:[job]},'instructions',{inquiries,mail:[{body:'後順位'}]},{});
  assert.ok(prompt.indexOf('問い合わせシート')<prompt.indexOf('最新Gmail本文'));assert.ok(prompt.includes('TAKANAWA'));assert.ok(prompt.includes('全文'.repeat(2500)));
  const remote=renderPrompt('{{PAYLOAD}}', {id:'batch',method:'fleet-mail',jobs:[{...job,inquiries}]});assert.match(remote,/問い合わせシートの依頼内容を最優先/);
});
test('required hook registration is idempotent and all new runtime files have fleet scope',t=>{
  const root=new URL('../',import.meta.url), manifest=JSON.parse(fs.readFileSync(new URL('tools/setup-manifest.json',root)));
  const scope=JSON.parse(fs.readFileSync(new URL('tools/fleet-scope.json',root)));
  for(const id of ['hook:inquiry-lookup-hint','settings:inquiry-lookup-hint-UserPromptSubmit'])assert.equal(manifest.items.find(i=>i.id===id).severity,'required');
  for(const file of ['tools/inquiry-lookup.mjs','tools/inquiry-lookup-hint.mjs','tools/lib/inquiry-sheet.mjs','tools/lib/mail-groups.mjs','config/mail-groups.json'])assert.equal(scope.entries.find(e=>e.path===file).scope,'fleet');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'inquiry-hook-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  for(let i=0;i<2;i++)execFileSync(process.execPath,['tools/register-hooks.mjs','--hooks-only'],{env:{...process.env,ORGIAST_HOME:home,ORGIAST_REPO:process.cwd()},stdio:'pipe'});
  const settings=readHookSettings(path.join(home,'.claude/settings.json'));
  const hooks=settings.hooks.UserPromptSubmit.flatMap(g=>g.hooks).filter(h=>h.command.includes('inquiry-lookup-hint.mjs'));
  assert.equal(hooks.length,1);assert.equal(hooks[0].timeout,5);
  const out=execFileSync(process.execPath,['tools/inquiry-lookup-hint.mjs'],{input:JSON.stringify({prompt:'明日10時の打合せ'}),encoding:'utf8'});
  assert.equal(JSON.parse(out).hookSpecificOutput.hookEventName,'UserPromptSubmit');
});
test('CLI validates flags and literal search terms cannot inject Gmail operators',()=>{
  assert.deepEqual(parseArgs(['ファブリカ','--user','satou@orgiast.jp','--json']),{terms:['ファブリカ'],user:'satou@orgiast.jp',json:true});
  assert.throws(()=>parseArgs(['--user']));assert.throws(()=>parseArgs(['--wat']));assert.equal(gmailQuery(['x" OR y']),'{"x  OR y"} newer_than:90d');
});

test('aborted Gmail cannot be reported as a successful empty result', async () => {
  const controller = new AbortController();
  await assert.rejects(searchGmail({ user:'kim@orgiast.jp',query:'test',signal:controller.signal,
    getToken:async()=> 'token',fetchImpl:async()=> {controller.abort(Error('test deadline'));return Response.json({messages:[{id:'unread'}]});} }), /test deadline/);
});
