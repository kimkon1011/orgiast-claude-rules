import test from 'node:test';
import assert from 'node:assert/strict';
import {syncCalendar,closed} from './deadline-watch.mjs';
import {readableEvent} from './lib/deadline-calendar.mjs';
import {AI_CALENDAR,isKimMeeting,routeCalendar} from './lib/calendar-shared.mjs';
import {targetCalendarForGroup,createCalendarClient,eventBody} from './schedule-sync.mjs';
const config={sheetId:'correct',calendar:{enabled:true},kimNames:['kim']};
for(const status of ['完了','不要','見送り']) test(`閉鎖 ${status}: 両カレンダーのarchive削除・別台帳/手入力を保護・再作成なし`,async()=>{
 const calls=[];
 const events=[{id:'ours',start:{date:'2026-11-26'},extendedProperties:{private:{deadlineId:'D-150',deadlineSheetId:'correct',deadlineArchive:'closed'}}},
 {id:'other',start:{date:'2026-11-26'},extendedProperties:{private:{deadlineId:'D-150',deadlineSheetId:'other'}}},
 {id:'manual',start:{date:'2026-11-26'}},
 {id:'unknown',start:{date:'2026-11-26'},extendedProperties:{private:{deadlineId:'D-150'}}},
 {id:'timed',start:{dateTime:'2026-11-26T10:00:00+09:00'},extendedProperties:{private:{deadlineId:'D-150',deadlineSheetId:'correct'}}}];
 const request=async(url,o)=>{calls.push({url,...o});return o.method?null:{items:events};};
 assert.equal(closed({status}),true);
 await syncCalendar({id:'D-150',status},{config,state:{},request});
 const changes=calls.filter(c=>c.method);assert.equal(changes.length,2);
 for(const c of changes){assert.equal(c.method,'DELETE');assert.match(c.url,/\/ours\?sendUpdates=none$/);}
});
test('件名は案件名・やることを保持し全管理番号を末尾へ',()=>{
 const e=readableEvent({id:'S-ABC',title:'C0039 神楽公演 V01 EIG-12',action:'D-150 機材を発送',company:'プレイバック'},config);
 assert.equal(e.summary,'【プレイバック様】神楽公演・機材を発送（C0039 / V01 / EIG-12 / D-150 / S-ABC）');
 for(const customerName of ['社内連絡','社内開発','オージャスト（所有者は山口明・個人）']){
  assert.match(readableEvent({id:'D-1',title:'定期確認',customerName},config).summary,/^【社内】定期確認/);
 }
 assert.match(readableEvent({id:'V01',title:'V220d 車検',kind:'車検'},config).summary,/^【社内・車両】V220d 車検（V01）$/);
});
test('面談設定は会議URLや参加者があっても制作チーム、他ソースは従来通り',()=>{
 const e={summary:'【自動】【面談設定】応募者面談',hangoutLink:'https://meet.google.com/abc',attendees:[{email:'kim@orgiast.jp'}]};
 assert.equal(isKimMeeting(e),false);assert.equal(routeCalendar(e),'seisaku-team@orgiast.jp');
 assert.equal(targetCalendarForGroup('#面談設定',{},'discord'),'seisaku-team@orgiast.jp');
 for(const source of ['line','gmail'])assert.equal(targetCalendarForGroup('#面談設定',{summary:'担当者と会議'},source),'primary');
 assert.equal(routeCalendar({summary:'【自動】作業'}),AI_CALENDAR);
 const body=eventBody({title:'面談',start:'2026-12-01T10:00:00+09:00',quote:'面談'},{source:'discord',id:'1',chat:'面談設定',sender:'担当',ts:'2026-11-26T00:00:00Z'},0);
 assert.equal(targetCalendarForGroup('面談設定',body,'discord'),'seisaku-team@orgiast.jp');assert.equal(body.attendees,undefined);
});
test('面談設定のAPI境界でkimを除外し、primaryへのinsertを拒否',async()=>{
 const body={summary:'【自動】【面談設定】応募者面談',attendees:[{email:'KIM@ORGIAST.JP'},{email:'staff@orgiast.jp'}]};
 let sent;
 const fetch=async(url,init)=>{assert.match(url,/seisaku-team%40orgiast.jp\/events\?sendUpdates=none$/);sent=JSON.parse(init.body);return {ok:true,json:async()=>({id:'1'})};};
 await createCalendarClient('mock',fetch,undefined,'seisaku-team@orgiast.jp').create(body);
 assert.deepEqual(sent.attendees,[{email:'staff@orgiast.jp'}]);
 await assert.rejects(createCalendarClient('mock',()=>assert.fail('primary insert')).create(body),/制作チーム/);
});
