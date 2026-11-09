import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCases, extractAimitsu, headerMap } from './satou-secretary-daily.mjs';

const now=new Date('2026-11-09T06:30:00+09:00');
const headers=['案件名','制作P','納品日','営業','予算項目','クライアント名','ｺｰﾄﾞ','制作','売上','実施計画URL','見積書URL','営業スタッフ'];
const row=(name,productionP,delivery,sales,state,client,code,production='',staff='')=>[name,productionP,delivery,sales,state,client,code,production,100,'plan','estimate',staff];

test('headerMap normalizes width and whitespace',()=>assert.equal(headerMap([' 営業ｻﾌﾞＰ ']).get('営業サブP'),0));
test('primary sales/production keeps every state and secondary staff only active states',()=>{
 const rows=[headers,
  row('一次担当の失注','', '2026-11-01','佐藤優奈','失注','A','A1'),
  row('スタッフ確定','', '2026-12-01','別担当','確定','B','B1','','佐藤 優奈'),
  row('スタッフ失注','', '2026-12-01','別担当','失注','C','C1','','佐藤優奈'),
  row('制作一次担当','', '2026-12-01','別担当','保留','D','D1','佐藤優奈')];
 assert.deepEqual(extractCases(rows,now).map(x=>x.code),['A1','B1','D1']);
});
test('closed cases delivered more than 30 days ago are excluded',()=>{
 const rows=[headers,row('古い完了','', '2026-10-01','佐藤優奈','納品完了','A','OLD'),row('最近完了','','2026-10-20','佐藤優奈','納品完了','B','NEW')];
 assert.deepEqual(extractCases(rows,now).map(x=>x.code),['NEW']);
});
test('Aimitsu extracts case number, company, messages and unanswered notices',()=>{
 const messages=[{from:'アイミツ <info@imitsu.jp>',threadId:'t1',subject:'通知',body:'案件No: 12345 企業名: 株式会社テスト\n未回答案件です'},
  {from:'support@imitsu.jp',threadId:'t2',subject:'株式会社見本様からのメッセージ',snippet:''},{from:'other@example.com',threadId:'t3',subject:'未回答案件'}];
 const got=extractAimitsu(messages); assert.equal(got.length,2); assert.deepEqual(got[0],{caseNo:'12345',company:'株式会社テスト',unanswered:true,subject:'通知',threadId:'t1',url:'https://mail.google.com/mail/?authuser=seisaku-team%40orgiast.jp#all/t1'}); assert.equal(got[1].company,'株式会社見本');
});
