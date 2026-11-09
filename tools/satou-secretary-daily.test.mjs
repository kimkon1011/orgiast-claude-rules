import test from'node:test';import assert from'node:assert/strict';import{headerMap,extractCases,extractAimitsu}from'./satou-secretary-daily.mjs';
const now=new Date('2026-11-09T06:30:00+09:00'),h=['案件名','納品日','営業','予算項目','クライアント名','ｺｰﾄﾞ','制作','売上','実施計画URL','見積書URL','営業スタッフ'],r=(n,d,s,st,c,code,p='',staff='')=>[n,d,s,st,c,code,p,100,'plan','estimate',staff];
test('ヘッダー名を正規化して特定',()=>assert.equal(headerMap([' 営業ｻﾌﾞＰ ']).get('営業サブP'),0));
test('一次担当は全件、担当者列は確定/アプローチのみ',()=>assert.deepEqual(extractCases([h,r('a','2026/11/01','佐藤優奈','失注','A','A'),r('b','2026/12/01','別','確定','B','B','','佐藤優奈'),r('c','2026/12/01','別','失注','C','C','','佐藤優奈'),r('d','2026/12/01','別','保留','D','D','佐藤優奈')],now).map(x=>x.code),['A','B','D']));
test('30日より前の納品完了/失注を除外',()=>assert.deepEqual(extractCases([h,r('old','2026/10/01','佐藤優奈','納品完了','A','OLD'),r('new','2026/10/20','佐藤優奈','納品完了','B','NEW')],now).map(x=>x.code),['NEW']));
test('アイミツ通知抽出',()=>{const x=extractAimitsu([{from:'info@imitsu.jp',threadId:'t',subject:'通知',body:'案件No: 123 企業名: 株式会社テスト\n未回答案件'}]);assert.equal(x[0].caseNo,'123');assert.equal(x[0].company,'株式会社テスト');assert.equal(x[0].unanswered,true);});
