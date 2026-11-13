import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJalanDetails, parseOfficial, buildRow, HEADERS, isoLocal } from './lahaina-kpi-daily.mjs';
import { taskCommand } from './lahaina-kpi-daily-register.mjs';

test('じゃらんの最安値とプラン数を抽出',()=>assert.deepEqual(parseJalanDetails('planName 15,000円 planCassette 12,500円 planCassette 13,000円 planCassette'),{minPrice:12500,planCount:3}));
test('じゃらん空本文は空値',()=>assert.deepEqual(parseJalanDetails(''),{minPrice:'',planCount:0}));
test('公式HPの予約導線・語句・最新日を抽出',()=>assert.deepEqual(parseOfficial('<a href="https://jalan.net/a">予約</a><a href="/reserve">予約</a>営業継続 牡蠣 2026/09/01 2026-10-20'),{reservationCount:2,continuing:true,oyster:true,latestNoticeDate:'2026-10-20'}));
test('日付はローカル日付',()=>assert.equal(isoLocal(new Date(2026,9,29,1)), '2026-10-29'));
test('行の列数とエラー結合',()=>{const row=buildRow({date:'2026-10-29',exposureScore:'2/6',jalan:{status:'buyable',minPrice:10000,planCount:2},rakuten:'delisted',official:{reservationCount:1,continuing:false},airbnb:'not_listed',booking:'unmeasurable',instagram:{followers:'10',posts:'3'},ga4:{sessions:'4',users:'2',sources:['google:3']},gsc:{clicks:1,impressions:8,queries:['犬:1/8']},errors:['x','y']});assert.equal(row.length,HEADERS.length);assert.equal(row.at(-1),'x | y');});
test('タスクコマンドはnode絶対パスで直接起動',()=>{const c=taskCommand({node:'C:\\Program Files\\nodejs\\node.exe',script:'C:\\repo x\\daily.mjs',home:'C:\\Users\\kim'});assert.equal(c.task,'"C:\\Program Files\\nodejs\\node.exe" "C:\\repo x\\daily.mjs"');assert.match(c.log,/run\.log/);});
test('parseJalanDetails nullでも例外が出ない', () => { assert.doesNotThrow(() => parseJalanDetails(null)); assert.deepEqual(parseJalanDetails(null), {minPrice:'', planCount:0}); });
test('parseJalanDetails undefinedでも例外が出ない', () => { assert.doesNotThrow(() => parseJalanDetails(undefined)); assert.deepEqual(parseJalanDetails(undefined), {minPrice:'', planCount:0}); });
test('parseOfficial nullでも例外が出ない', () => { assert.doesNotThrow(() => parseOfficial(null)); assert.deepEqual(parseOfficial(null), {reservationCount:0, continuing:false, oyster:false, latestNoticeDate:''}); });
test('parseOfficial undefinedでも例外が出ない', () => { assert.doesNotThrow(() => parseOfficial(undefined)); assert.deepEqual(parseOfficial(undefined), {reservationCount:0, continuing:false, oyster:false, latestNoticeDate:''}); });
test('buildRow エラー列が空でも動く', () => {
  const row = buildRow({date:'2026-11-13',exposureScore:'2/6',jalan:{status:'buyable',minPrice:10000,planCount:2},rakuten:'delisted',official:{reservationCount:1,continuing:false},airbnb:'not_listed',booking:'unmeasurable',instagram:{followers:'10',posts:'3'},ga4:{sessions:'4',users:'2',sources:[]},gsc:{clicks:1,impressions:8,queries:[]},errors:[]});
  assert.equal(row.length, HEADERS.length);
  assert.equal(row.at(-1), '');
});
