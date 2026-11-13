import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseJalanDetails, parseOfficial, parseInstagram, collect, buildRow, HEADERS, isoLocal } from './lahaina-kpi-daily.mjs';
import { measure } from './lahaina-exposure-check.mjs';
import { taskCommand } from './lahaina-kpi-daily-register.mjs';

test('じゃらんの最安値とプラン数を抽出',()=>assert.deepEqual(parseJalanDetails('planName 15,000円 planCassette 12,500円 planCassette 13,000円 planCassette'),{minPrice:12500,planCount:3}));
test('じゃらん空本文は空値と取得失敗理由',()=>{const r=parseJalanDetails('');assert.equal(r.minPrice,'');assert.equal(r.planCount,'');assert.match(r.error,/取得失敗/);});
test('公式HPの予約導線・語句・最新日を抽出',()=>assert.deepEqual(parseOfficial('<a href="https://jalan.net/a">予約</a><a href="/reserve">予約</a>営業継続 牡蠣 2026/09/01 2026-10-20'),{reservationCount:2,continuing:true,oyster:true,latestNoticeDate:'2026-10-20'}));
test('日付はローカル日付',()=>assert.equal(isoLocal(new Date(2026,9,29,1)), '2026-10-29'));
test('行の列数とエラー結合',()=>{const row=buildRow({date:'2026-10-29',exposureScore:'2/6',jalan:{status:'buyable',minPrice:10000,planCount:2},rakuten:'delisted',official:{reservationCount:1,continuing:false},airbnb:'not_listed',booking:'unmeasurable',instagram:{followers:'10',posts:'3'},ga4:{sessions:'4',users:'2',sources:['google:3']},gsc:{clicks:1,impressions:8,queries:['犬:1/8']},errors:['x','y']});assert.equal(row.length,HEADERS.length);assert.equal(row.at(-1),'x | y');});
test('タスクコマンドはnode絶対パスで直接起動',()=>{const c=taskCommand({node:'C:\\Program Files\\nodejs\\node.exe',script:'C:\\repo x\\daily.mjs',home:'C:\\Users\\kim'});assert.equal(c.task,'"C:\\Program Files\\nodejs\\node.exe" "C:\\repo x\\daily.mjs"');assert.match(c.log,/run\.log/);});

for (const parser of [parseJalanDetails,parseOfficial,parseInstagram]) {
  for (const html of [null,undefined,'','  \n ']) {
    test(`${parser.name}: ${JSON.stringify(html)} は空の結果と取得失敗理由`,()=>{
      const result=parser(html);
      assert.match(result.error,/取得失敗/);
      for (const [key,value] of Object.entries(result)) {
        if(key!=='error') assert.ok(value==='' || value===null,`${key} must be unknown, not zero/false`);
      }
    });
  }
}
test('Instagram公開HTMLの数値を抽出',()=>assert.deepEqual(parseInstagram('123 Followers 45 Posts'),{followers:'123',posts:'45',error:''}));

const mediaHosts = [
  ['じゃらん','www.jalan.net'],['公式HP','lahaina.jp'],['楽天トラベル','travel.rakuten.co.jp'],
  ['Airbnb','www.airbnb.jp'],['Booking.com','www.booking.com'],
];
for (const [failedMedia,failedHost] of mediaHosts) {
  test(`${failedMedia}の取得失敗でも他媒体の値を保存しSheetへ1行渡す`,async t=>{
    const outputDir=fs.mkdtempSync(path.join(os.tmpdir(),'lahaina-kpi-test-'));
    t.after(()=>fs.rmSync(outputDir,{recursive:true,force:true}));
    let writes=0;
    const fetchImpl=async url=>{
      if(new URL(url).hostname===failedHost) throw new TypeError('fetch failed',{cause:{code:'ECONNRESET'}});
      return new Response('<a href="/reserve">予約</a>営業継続 planName 12,500円');
    };
    const result=await collect({now:new Date(2026,10,13,12),outputDir,dependencies:{
      measure:options=>measure({...options,fetchImpl}),
      getInstagram:async()=>({followers:123,posts:45}),
      getGa4:async()=>({sessions:10,users:8,sources:['google:10']}),
      getGsc:async()=>({clicks:2,impressions:30,queries:['宿:2/30']}),
      writeSheet:async row=>{writes++;assert.equal(row.length,HEADERS.length);return {verified:true,row};},
    }});
    assert.equal(writes,1);
    assert.equal(result.row[0],'2026-11-13');
    assert.equal(result.row[10],123);
    assert.equal(result.row[12],10);
    assert.equal(result.row[15],2);
    assert.equal(result.errors.length,1);
    assert.ok(result.errors[0].includes(`${failedMedia}: 取得失敗`));
    assert.ok(result.errors[0].includes(failedHost));
    assert.match(result.errors[0],/ECONNRESET.*HTTP: 応答なし/);
    if(failedMedia==='じゃらん') assert.deepEqual(result.row.slice(2,5),['unmeasurable','','']);
    else assert.deepEqual(result.row.slice(2,5),['buyable',12500,1]);
    if(failedMedia==='公式HP') assert.deepEqual(result.row.slice(6,8),['','']);
    else assert.deepEqual(result.row.slice(6,8),[1,'あり']);
    assert.deepEqual(JSON.parse(fs.readFileSync(result.localFile,'utf8')).row,result.row);
    assert.deepEqual(result.write.row,result.row);
    assert.equal(result.fetches.find(r=>r.media===failedMedia).htmlWasNull,true);
    assert.ok(result.fetches.every(r=>!('html' in r)));
  });
}

test('HTML全件空・API例外でも行を構築して書き込みを続行',async t=>{
  const outputDir=fs.mkdtempSync(path.join(os.tmpdir(),'lahaina-kpi-test-'));
  t.after(()=>fs.rmSync(outputDir,{recursive:true,force:true}));
  const fail=async()=>{throw Error('API unavailable');};
  const result=await collect({now:new Date(2026,10,13,12),outputDir,dependencies:{
    measure:options=>measure({...options,fetchImpl:async()=>new Response('')}),
    getInstagram:fail,getGa4:fail,getGsc:fail,
    writeSheet:async row=>({verified:true,row}),
  }});
  assert.equal(result.row.length,HEADERS.length);
  assert.equal(result.errors.length,8);
  assert.match(result.row.at(-1),/HTMLが空.*HTTP: 200/);
  for(const media of ['Instagram','GA4','GSC']) assert.ok(result.row.at(-1).includes(`${media}取得失敗: API unavailable`));
  assert.equal(result.write.verified,true);
});
