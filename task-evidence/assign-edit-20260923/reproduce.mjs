import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const code=fs.readFileSync(new URL('./snapshot/src/Phase_AssignRequest.js',import.meta.url),'utf8');
function run(input,broken=false) {
 const values=Array(66).fill(''); values[0]='2026-09-23T00:00:00Z';values[2]='イベント関連';values[16]='デザイナー';values[17]=20000;values[18]=1;values[19]='ドライバー';values[20]=20000;values[21]=1;
 let saved=JSON.stringify({rows:[{type:'event',values}],docUrl:'https://example.invalid/draft',requesterName:'test'});
 const capture={writes:[],notifications:[],documentReads:0};
 const ctx={PropertiesService:{getScriptProperties:()=>({getProperty:()=>saved,setProperty:(k,v)=>{saved=v;}})},_PanelInput_currentSheet:()=>{if(broken)throw Error('panel unavailable');return {};},PanelInput_read:()=>input,Utilities:{formatDate:()=> '2026/09/23'},MasterWriteBack_recordArtifact:()=>{}};
 vm.createContext(ctx);vm.runInContext(code,ctx);
 Object.assign(ctx,{_AssignSheet_ensureDocUrlHeader:()=>{},_AssignSheet_insertRowsTop:rows=>{capture.writes.push(...rows);return rows.map((_,i)=>i+3);},_AssignSheet_buildNotifyText:()=> 'mock notification',_AssignSheet_notifyDiscord:text=>{capture.notifications.push(text);return {sent:true};},_AssignSheet_masterUrl:()=> 'https://example.invalid/sheet',DocumentApp:{openById:()=>{capture.documentReads++;throw Error('unexpected');}}});
 capture.result=ctx.Phase_AssignRequest_sendDraft('test');
 return capture;
}
const role=run('除外:デザイナー');assert.equal(role.writes[0][16],'デザイナー');assert.equal(role.writes[0][19],'ドライバー');assert.equal(role.documentReads,0);
const missing=run('除外:イベント関連',true);assert.equal(missing.writes.length,1);assert.equal(missing.notifications.length,1);
const excluded=run('除外:イベント関連');assert.equal(excluded.writes.length,0);assert.equal(excluded.notifications.length,0);
console.log(JSON.stringify({sourceCommit:'4210734',networkUsed:false,findings:[{name:'職種単位の除外が効かない',input:'除外:デザイナー',writtenPositions:[role.writes[0][16],role.writes[0][19]]},{name:'Doc再読込なし',documentReads:role.documentReads},{name:'パネル読取エラーでも送信する',sheetRows:missing.writes.length,notifications:missing.notifications.length},{name:'イベント関連全体の除外は機能する',sheetRows:excluded.writes.length,notifications:excluded.notifications.length}]},null,2));
