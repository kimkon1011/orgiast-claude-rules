import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const source = fs.readFileSync(new URL('./snapshot/src/Phase_AssignRequest.js', import.meta.url), 'utf8');
const observations = [];
for (const panelFails of [false, true]) {
  let saved = JSON.stringify({rows:[{type:'construction',values:['2026-09-24','保存時の施工担当']},{type:'event',values:['2026-09-24','保存時のイベント担当']}],docUrl:'https://example.invalid/draft',title:'検証用',requesterName:'検証用'});
  const inserted = [], notifications = [];
  let docReads=0;
  const c = {
    PropertiesService:{getScriptProperties:()=>({getProperty:()=>saved,setProperty:(_,v)=>{saved=v;}})},
    _PanelInput_currentSheet:()=>{if(panelFails)throw Error('入力欄の読取失敗');return {};},
    PanelInput_read:()=> '除外:施工スタッフ',
    Utilities:{formatDate:()=> '2026/09/24'},
    MasterWriteBack_recordArtifact:()=>{},
    DocumentApp:{openById:()=>{docReads++;throw Error('本テストでは外部接続禁止');}},
  };
  vm.createContext(c);vm.runInContext(source,c);
  Object.assign(c,{
    _AssignSheet_ensureDocUrlHeader:()=>{},
    _AssignSheet_insertRowsTop:rows=>{inserted.push(...rows);return rows.map((_,i)=>i+2);},
    _AssignSheet_buildNotifyText:()=> '検証用通知',
    _AssignSheet_notifyDiscord:text=>{notifications.push(text);return {sent:true};},
    _AssignSheet_masterUrl:()=> 'https://example.invalid/sheet',
  });
  c.Phase_AssignRequest_sendDraft('test-case');
  c.Phase_AssignRequest_sendDraft('test-case');
  assert.equal(inserted.length,panelFails ? 4 : 2);
  assert.equal(notifications.length,2);
  assert.match(notifications[1],/^【修正版】/);
  assert.equal(docReads,0);
  observations.push({panelFails,insertedRowsAfterTwoCalls:inserted.length,notificationsStubbed:notifications.length,secondMarkedRevised:true,documentReadCalls:docReads,firstInsertedValue:inserted[0][1]});
}
fs.writeFileSync(new URL('./runtime-observations.json',import.meta.url),JSON.stringify({externalRequests:0,observations},null,2));
console.log(JSON.stringify(observations,null,2));
