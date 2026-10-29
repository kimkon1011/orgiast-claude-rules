import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJalanDetails, parseOfficial, buildRow, HEADERS, isoLocal } from './lahaina-kpi-daily.mjs';

test('じゃらんの最安値とプラン数を抽出',()=>assert.deepEqual(parseJalanDetails('宿泊プラン planName 15,000円 planCassette 12,500円'),{minPrice:12500,planCount:3}));
test('じゃらん空本文は空値',()=>assert.deepEqual(parseJalanDetails(''),{minPrice:'',planCount:0}));
test('公式HPの予約導線・語句・最新日を抽出',()=>assert.deepEqual(parseOfficial('<a href="https://jalan.net/a">予約</a><a href="/reserve">予約</a>営業継続 牡蠣 2026/09/01 2026-10-20'),{reservationCount:2,continuing:true,oyster:true,latestNoticeDate:'2026-10-20'}));
test('日付はローカル日付',()=>assert.equal(isoLocal(new Date(2026,9,29,1)), '2026-10-29'));
test('行の列数とエラー結合',()=>{const row=buildRow({date:'2026-10-29',exposureScore:'2/6',jalan:{status:'buyable',minPrice:10000,planCount:2},rakuten:'delisted',official:{reservationCount:1,continuing:false},airbnb:'not_listed',booking:'unmeasurable',instagram:{followers:'10',posts:'3'},ga4:{sessions:'4',users:'2',sources:['google:3']},gsc:{clicks:1,impressions:8,queries:['犬:1/8']},errors:['x','y']});assert.equal(row.length,HEADERS.length);assert.equal(row.at(-1),'x | y');});
