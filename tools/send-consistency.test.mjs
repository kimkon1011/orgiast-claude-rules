import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSendConsistency, formatConsistencyFindings } from './lib/send-consistency.mjs';
import { afterSendCleanup, collectSendConsistency, readSentRegistry, scanScheduled, main, subjectHash, decodeTaskOutput } from './send-consistency-check.mjs';

const base={channel:'gmail',to:'customer@example.com',subject:'お見積り',text:'ご案内します。',draftId:'d1',now:'2026-11-27T12:00:00+09:00',draftReadAt:'2026-11-27T10:00:00+09:00'};
const directive={id:'no-ai-note',since:'2026-11-27',pattern:'(AI|Claude|自動作成|自動生成|生成AI)(が|で|により|による)?(作成|下書き|生成)|※.*AI',message:'金さんの指示でAI注記を外す'};
const cases=[
 ['C1','008再確認手順の華の湯・梅津・河村 draftId', {scheduledSends:['華の湯','梅津','河村'].map(name=>({draftId:'d1',where:`008/recheck-prompt-kim.md:${name}`}))},['DUP_SCHEDULED']],
 ['C2','同一宛先・正規化件名の送信済み',{sentHistory:[{to:base.to,subject:'Re: Fwd: お 見積り',at:'2026-11-26'}]},['DUP_ALREADY_SENT']],
 ['C3','sent-registryの同一draftId',{sentHistory:[{draftId:'d1',at:'2025-01-01'}]},['DUP_ALREADY_SENT']],
 ['C4','11/29（金）の曜日',{text:'開催: 11/29（金）'},['DATE_WEEKDAY_MISMATCH']],
 ['C5','ブース営業CC漏れ',{requiredCc:['satou@orgiast.jp']},['CC_MISSING']],
 ['C6','AI注記の外し忘れ',{text:'※本メールはAIが作成しました',directives:[directive]},['DIRECTIVE_NOT_APPLIED']],
 ['C7','別アカウントの同件下書き',{otherDrafts:[{account:'kim@orgiast.jp',to:base.to,subject:base.subject,draftId:'d2'}]},['DUP_OTHER_DRAFT']],
 ['C8','過ぎた候補日時',{text:'候補日: 11/26 14:00'},['DATE_PAST']],
 ['C9','直前の新着で日程変更',{text:'12/3 14:00',threadMessages:[{side:'external',at:'2026-11-27T11:00:00+09:00',text:'12/3 は難しく 12/4 15時でお願いします'}]},['INBOUND_NEWER','INBOUND_CONFLICT']],
 ['C10','過去の金額と矛盾',{text:'金額は15万円です',threadMessages:[{side:'self',text:'金額は12万円です'}]},['CONTRADICTS_PAST']],
 ['C11','送信履歴取得不能',{unverified:['sentHistory']},['UNVERIFIED_sentHistory']],
 ['C12','すべて整合',{text:'山田様\n開催: 11/29（日） 14:00\n金額12万円、数量2台',knownNames:['山田'],cc:['satou@orgiast.jp'],requiredCc:['satou@orgiast.jp'],directives:[directive],threadMessages:[{side:'external',at:'2026-11-27T09:00:00+09:00',text:'11/29 14:00'}]},[]],
 ['C13','過去資料の言及は除外',{text:'11/20にいただいた資料、ありがとうございます。'},[]],
];
for(const [id,title,patch,expected] of cases)test(`${id} ${title}`,t=>{
 const result=checkSendConsistency({...base,...patch});const actual=[...new Set(result.findings.map(f=>f.code))];
 t.diagnostic('CASE_RESULT '+JSON.stringify({id,title,expected,actual,pass:JSON.stringify(actual)===JSON.stringify(expected)}));
 assert.deepEqual(actual,expected);assert.equal(result.ok,expected.length===0);
 if(id==='C4')assert.ok(result.findings[0].where.includes('11/29（金）'));
 if(id==='C9')assert.ok(result.findings.find(f=>f.code==='INBOUND_CONFLICT').where.includes('12/3 14:00'));
});
test('実装済み読み取りの失敗はallowUnverifiedの理由があっても停止',()=>{
 const input={...base,unverified:['calendarEvents']};
 assert.equal(checkSendConsistency(input,{allowUnverified:['calendarEvents']}).ok,false);
 const result=checkSendConsistency(input,{allowUnverified:['calendarEvents'],unverifiedReasons:{calendarEvents:'日程を含まない単純な受領連絡'}});
 assert.equal(result.ok,false);assert.equal(result.findings[0].code,'UNVERIFIED_calendarEvents');assert.notEqual(result.findings[0].severity,'warning');
});
test('14日超・別宛先・自身の下書き・変更説明は誤検出しない',()=>{
 assert.equal(checkSendConsistency({...base,text:'改めて金額15万円です',sentHistory:[{to:base.to,subject:base.subject,at:'2026-11-01'},{to:'other@example.com',subject:base.subject,at:'2026-11-26'}],otherDrafts:[{to:base.to,subject:base.subject,draftId:'d1'}],threadMessages:[{side:'self',text:'12万円'}]}).ok,true);
});
test('氏名・カレンダー・数量の不一致を検出',()=>{
 const result=checkSendConsistency({...base,text:'河村様\n開催: 12/3 14:00、3台',knownNames:['山田'],calendarEvents:[{sameCase:true,start:'2026-12-04T15:00:00+09:00'}],threadMessages:[{side:'self',text:'2台'}]});
 for(const code of ['NAME_MISMATCH','CAL_MISMATCH','CONTRADICTS_PAST'])assert.ok(result.findings.some(f=>f.code===code));
 assert.match(formatConsistencyFindings(result.findings),/^送信前の整合性チェック: 送信を止めました/);
});
test('同じ本文の類似度・ハッシュで重複、空件名は全件重複にしない',()=>{
 assert.equal(checkSendConsistency({...base,sentHistory:[{to:base.to,text:base.text,at:'2026-11-26'}]}).ok,false);
 assert.equal(checkSendConsistency({...base,subject:'',sentHistory:[{to:base.to,subjectHash:subjectHash(''),at:'2026-11-26'}],subjectHash:subjectHash('')}).ok,true);
});
test('年跨ぎの曜日・同日候補の時刻・日付だけの期限',()=>{
 assert.equal(checkSendConsistency({...base,now:'2026-12-31T12:00:00+09:00',text:'開催: 1/1（金）'}).ok,true);
 assert.equal(checkSendConsistency({...base,text:'期限: 11/27'}).ok,true);
 assert.equal(checkSendConsistency({...base,text:'候補: 11/27 11:00'}).ok,false);
});
function temp(t){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'consistency-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));return dir;}
test('afterSendCleanup: 送信済み元下書きだけ削除し404、台帳も読み戻す',async t=>{
 const home=temp(t);fs.mkdirSync(path.join(home,'.claude','followup-ledger'),{recursive:true});
 fs.writeFileSync(path.join(home,'.claude','followup-ledger','ledger.json'),JSON.stringify({items:[{id:'r1',draftId:'d1'}]}));
 const calls=[];let deleted=false;const output=[];
 const result=await afterSendCleanup({...base,sentMessageId:'m1',scheduledSends:[{draftId:'d1',where:'recheck.md'}]}, {home,stdout:s=>output.push(s),getDraft:async id=>{calls.push(`get:${id}`);return{status:deleted?404:200,ok:!deleted};},deleteDraft:async id=>{calls.push(`delete:${id}`);deleted=true;return{ok:true,status:204};}});
 assert.equal(result.ok,true);assert.deepEqual(calls,['get:d1','delete:d1','get:d1']);assert.equal(readSentRegistry(home)[0].draftId,'d1');
 assert.equal(JSON.parse(fs.readFileSync(path.join(home,'.claude','followup-ledger','ledger.json'))).items[0].sendStatus,'送信済み');
 assert.equal(result.scheduledSends[0].status,'送信済み');assert.equal(output.length,1);
});
test('後始末403・削除後残存でも送信済み記録を失わない',async t=>{
 const home=temp(t);let deleted=0;
 const result=await afterSendCleanup({...base,sentMessageId:'m1'}, {home,stdout:()=>{},getDraft:async()=>({status:403,ok:false}),deleteDraft:async()=>{deleted++;}});
 assert.equal(result.ok,false);assert.equal(deleted,0);assert.equal(readSentRegistry(home).length,1);
 await assert.rejects(afterSendCleanup(base,{home}),/成功ID/);
});
test('タスクの多段プロンプトと引用パス、読めない参照を照合',()=>{
 const files=new Map([[path.resolve('recheck.ps1'),'node test.mjs "prompt.md"'],[path.resolve('prompt.md'),'下書き d1 を再確認']]);
 const result=scanScheduled(base,{home:os.tmpdir(),cwd:process.cwd(),taskCsv:'"task","node test.mjs recheck.ps1"\n',readFile:f=>{if(!files.has(f))throw Error('欠落');return files.get(f);}});
 assert.equal(result.rows[0].draftId,'d1');assert.equal(result.failures.length,0);
 assert.ok(scanScheduled(base,{home:os.tmpdir(),taskCsv:'"task","claude -p missing.md"',readFile:()=>{throw Error('欠落');}}).failures.includes('scheduledSends'));
});
test('読めたタスクスクリプト内の古い資料名は全体を取得不能にしない',()=>{
 const script=path.resolve('task.ps1');
 const result=scanScheduled(base,{home:os.tmpdir(),cwd:process.cwd(),taskCsv:'"task","powershell.exe -File task.ps1"\n',readFile:file=>{
  if(file===script)return "# 過去資料 COMPARE.md は削除済み\nnode worker.mjs";
  if(file.endsWith('worker.mjs'))return '宛先 customer@example.com';
  throw Object.assign(Error('missing'),{code:'ENOENT'});
 }});
 assert.equal(result.failures.length,0);assert.equal(result.rows.length,1);
});
test('収集は全APIを注入し、他PC欠落・取得失敗を閉じる',async t=>{
 const home=temp(t), deps={home,taskCsv:'',gmailData:async()=>({sentHistory:[],otherDrafts:[],threadMessages:[],failures:[]}),followupRows:async()=>[],calendarEvents:async()=>[],directives:[directive],pcMap:{'008':{}},fleetSnapshot:{labels:['008'],checkedAt:base.now,sentHistory:[],scheduledSends:[],otherDrafts:[]}};
 let data=await collectSendConsistency(base,deps);assert.deepEqual(data.unverified,[]);
 data=await collectSendConsistency(base,{...deps,fleetSnapshot:{...deps.fleetSnapshot,labels:[]},gmailData:async()=>{throw Error('403');}});
 assert.ok(data.unverified.includes('otherPcState'));assert.ok(data.unverified.includes('sentHistory'));
});
test('Discordだけは未配備のfleet収集器をunsupportedとして明示し、壊れたスナップショットは停止',async t=>{
 const home=temp(t), common={home,taskCsv:'',fetchHistory:async()=>({target:'dm',messages:[]}),followupRows:async()=>[],calendarEvents:async()=>[],directives:[directive],pcMap:{'008':{}}};
 let data=await collectSendConsistency({...base,channel:'discord'},common);
 assert.ok(data.unsupported.includes('otherPcState'));assert.ok(!data.unverified.includes('otherPcState'));
 fs.mkdirSync(path.join(home,'.claude'),{recursive:true});fs.writeFileSync(path.join(home,'.claude','send-consistency-fleet.json'),'{broken');
 data=await collectSendConsistency({...base,channel:'discord'},common);
 assert.ok(data.unverified.includes('otherPcState'));
});
test('CLI 終了コード0/2/3とJSON',async t=>{
 const home=temp(t),file=path.join(home,'body.txt');fs.writeFileSync(file,base.text);
 for(const [patch,expected] of [[{},0],[{scheduledSends:[{draftId:'d1'}]},2],[{unverified:['sentHistory']},3]]){
  const lines=[];const code=await main(['--channel','gmail','--to',base.to,'--body-file',file,'--json'],{readRecentSent:async()=>[],collect:async()=>({...base,...patch}),stdout:s=>lines.push(s)});
  assert.equal(code,expected);assert.equal(JSON.parse(lines[0]).ok,expected===0);
 }
});
test('Gmail実収集器: DWDの3アカウント・ページ継続・スレッド・CCをモックAPIで照合',async t=>{
 const home=temp(t),accounts=[],queries=[];
 const msg=(id,from,to,subject)=>({id,threadId:'thread1',internalDate:String(Date.parse('2026-11-26T12:00:00+09:00')),payload:{headers:[{name:'From',value:from},{name:'To',value:to},{name:'Subject',value:subject},{name:'Cc',value:'past@example.com'}],body:{data:Buffer.from('本文').toString('base64url')}}});
 const fetchImpl=async(url,options)=>{
  const u=new URL(url);queries.push(u.searchParams.get('q') || '');assert.equal(options.method,undefined);
  let data;
  if(u.pathname.endsWith('/messages'))data={messages:[{id:u.searchParams.has('pageToken')?'m2':'m1'}],...(!u.searchParams.has('pageToken')?{nextPageToken:'page2'}:{})};
  else if(u.pathname.endsWith('/drafts'))data={drafts:[{id:'d2'}]};
  else if(u.pathname.includes('/messages/'))data=msg('m','self@example.com',base.to,base.subject);
  else if(u.pathname.includes('/drafts/'))data={message:msg('draftmsg','self@example.com',base.to,base.subject)};
  else if(u.pathname.includes('/threads/'))data={messages:[msg('inbound','山田 <customer@example.com>','seisaku-team@orgiast.jp','Re: お見積り')]};
  else assert.fail(url);
  return new Response(JSON.stringify(data),{status:200});
 };
 const data=await collectSendConsistency({...base,threadId:'thread1',subject:'ブース'}, {home,fetchImpl,getToken:async({user})=>{accounts.push(user);return 'mock-token';},taskCsv:'',followupRows:async()=>[],calendarEvents:async()=>[],pcMap:{'008':{}},fleetSnapshot:{labels:['008'],checkedAt:base.now,sentHistory:[],scheduledSends:[],otherDrafts:[]}});
 assert.deepEqual(accounts,['seisaku-team@orgiast.jp','kim@orgiast.jp','cr@orgiast.jp']);assert.equal(data.sentHistory.length,6);assert.equal(data.otherDrafts.length,3);assert.equal(data.threadMessages.length,1);
 assert.ok(data.requiredCc.includes('satou@orgiast.jp'));assert.ok(data.requiredCc.includes('past@example.com'));assert.deepEqual(data.knownNames,['山田']);assert.deepEqual(data.unverified,[]);
 assert.ok(queries.some(q=>q.includes('in:sent')&&q.includes('newer_than:14d')&&q.includes(base.to)));
});
test('タスクCSVはUTF-8・UTF-16とWindowsの日本語出力を読む',()=>{
 const text='"再確認","node test.mjs"';
 assert.equal(decodeTaskOutput(Buffer.from(text)),text);
 assert.equal(decodeTaskOutput(Buffer.concat([Buffer.from([255,254]),Buffer.from(text,'utf16le')])),text);
 assert.equal(decodeTaskOutput(Buffer.from([0x93,0xfa,0x96,0x7b])),'日本');
});
test('台帳・カレンダーの取得中に届いた新着も最終読み戻しで止める',async t=>{
 const home=temp(t);
 const data=await collectSendConsistency({...base,text:'12/3 14:00'}, {home,taskCsv:'',gmailData:async()=>({sentHistory:[],otherDrafts:[],threadMessages:[],failures:[],refreshThread:async()=>[{side:'external',at:'2026-11-27T11:59:00+09:00',text:'12/4 15時でお願いします'}]}),followupRows:async()=>[],calendarEvents:async()=>[],pcMap:{},fleetSnapshot:{labels:[],checkedAt:base.now,sentHistory:[],scheduledSends:[],otherDrafts:[]}});
 const result=checkSendConsistency(data);assert.ok(result.findings.some(f=>f.code==='INBOUND_NEWER'));assert.ok(result.findings.some(f=>f.code==='INBOUND_CONFLICT'));
});
test('PowerShell 5の再確認ラッパーからclaudeの手順書まで読む',()=>{
 const result=scanScheduled(base,{home:os.tmpdir(),cwd:process.cwd(),taskCsv:'"タスク名","実行するタスク"\n"再確認","powershell.exe -File recheck.ps1"',readFile:file=>file.endsWith('recheck.ps1')?'claude -p "手順書.md"':'下書き d1 を送る'});
 assert.ok(result.rows.some(row=>row.where.endsWith('手順書.md')&&row.draftId==='d1'));assert.equal(result.failures.length,0);
});
