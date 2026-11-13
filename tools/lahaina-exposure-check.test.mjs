import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STATUS,
  judgeJalan,
  judgeRakuten,
  judgeOfficial,
  judgeBooking,
  judgeAirbnb,
  fetchPageResult,
  measure,
} from './lahaina-exposure-check.mjs';

test('取得診断: HTTP 503の本文をHTMLとして判定しない',async()=>{
  const result=await fetchPageResult('https://example.test/',20,async()=>new Response('12,500円',{status:503}));
  assert.deepEqual(result,{html:null,httpStatus:503,error:'取得失敗: HTTP 503'});
});
test('取得診断: 通信例外の原因とHTTP応答なしを保持',async()=>{
  const result=await fetchPageResult('https://example.test/',20,async()=>{throw new TypeError('fetch failed',{cause:{code:'ENOTFOUND'}});});
  assert.equal(result.html,null);
  assert.equal(result.httpStatus,null);
  assert.match(result.error,/取得失敗.*ENOTFOUND/);
});
test('取得診断: タイムアウトを保持',async()=>{
  const result=await fetchPageResult('https://example.test/',0.01,async(url,{signal})=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})));
  assert.equal(result.html,null);
  assert.match(result.error,/タイムアウト/);
});
test('取得診断: 本文読み取り失敗時も受信済みHTTP状態を保持',async()=>{
  const result=await fetchPageResult('https://example.test/',20,async()=>({ok:true,status:200,arrayBuffer:async()=>{throw Error('body interrupted');}}));
  assert.equal(result.html,null);
  assert.equal(result.httpStatus,200);
  assert.match(result.error,/body interrupted/);
});
test('取得診断: 正常なShift_JIS本文の復号を維持',async()=>{
  const result=await fetchPageResult('https://example.test/',20,async()=>new Response(Uint8Array.from([0x89,0x7e])));
  assert.equal(result.html,'円');
  assert.equal(result.error,'');
});
test('1媒体のHTTP失敗でも残りの計測を続行し、HTMLは既定で返さない',async()=>{
  const result=await measure({dateStr:'2026-11-27',fetchImpl:async url=>new Response('<a href="/reserve">予約</a>12,500円',{status:url.includes('jalan.net')?503:200})});
  assert.equal(result.results.length,6);
  assert.equal(result.buyable,2);
  assert.equal(result.results[0].status,STATUS.UNMEASURABLE);
  assert.equal(result.results[0].httpStatus,503);
  assert.match(result.results[0].error,/取得失敗/);
  assert.ok(result.results.every(r=>!('html' in r)));
});

test('じゃらん: 料金表記があれば在庫が買える', () => {
  const r = judgeJalan('<html>素泊まりプラン 13,750円 残1部屋</html>');
  assert.equal(r.status, STATUS.BUYABLE);
  assert.match(r.evidence, /13,750円/);
});

test('じゃらん: 予約受付を停止なら not_listed', () => {
  assert.equal(judgeJalan('<html>予約受付を停止中です</html>').status, STATUS.NOT_LISTED);
});

test('じゃらん: 空応答は unmeasurable', () => {
  assert.equal(judgeJalan(null).status, STATUS.UNMEASURABLE);
});

test('楽天: 掲載終了を検出', () => {
  assert.equal(
    judgeRakuten('<title>楽天トラベル : 指定されたページは掲載終了しました。</title>').status,
    STATUS.DELISTED
  );
});

test('楽天: 通常ページは buyable', () => {
  assert.equal(judgeRakuten('<html>宿のページ</html>').status, STATUS.BUYABLE);
});

test('公式HP: 予約導線リンクがあれば buyable', () => {
  const r = judgeOfficial('<a href="/yad353005/plan/">じゃらん</a>');
  assert.equal(r.status, STATUS.BUYABLE);
});

test('公式HP: 予約導線リンクが無ければ not_listed', () => {
  assert.equal(
    judgeOfficial('<a href="/about/">会社概要</a><a href="/contact/">お問い合わせ</a>').status,
    STATUS.NOT_LISTED
  );
});

test('Booking: 検索語エコーで buyable にしない（誤検知防止・常に未計測）', () => {
  const echo = 'x'.repeat(30000) + '<h1>ラハイナ の検索結果</h1>';
  assert.equal(judgeBooking(echo).status, STATUS.UNMEASURABLE);
});

test('Booking: 施設カード様の本文でも buyable にしない（3回中1回ぶれた実測への対処）', () => {
  const big = 'x'.repeat(30000) + '<div data-testid="property-card">ラハイナ</div>';
  assert.equal(judgeBooking(big).status, STATUS.UNMEASURABLE);
});

test('Booking: 応答が空でも未計測', () => {
  assert.equal(judgeBooking(null).status, STATUS.UNMEASURABLE);
});

test('Booking: 小さい本文は bot遮断疑いで unmeasurable', () => {
  assert.equal(judgeBooking('<html>checking your browser</html>').status, STATUS.UNMEASURABLE);
});

test('Airbnb: ラハイナなし → not_listed', () => {
  const big = 'x'.repeat(30000);
  assert.equal(judgeAirbnb(big).status, STATUS.NOT_LISTED);
});

test('Airbnb: ラハイナ検出で buyable', () => {
  const big = 'x'.repeat(30000) + 'ラハイナ';
  assert.equal(judgeAirbnb(big).status, STATUS.BUYABLE);
});
