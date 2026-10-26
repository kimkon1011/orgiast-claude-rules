import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectPayeeSheets, parseSheetRows, sheetDate, PAYEE_SHEETS } from './sheets-source.mjs';
import { collectPurchasing, extractPayee, resolvePayees, runPayeeRules, closest } from './resolve-payees.mjs';
import { summarizeFootprint, footprintExclusions, buildFootprint } from './footprint.mjs';
import { payeeSearch, normalizeKana } from './payee-search.mjs';
import { replayResolvedFootprint } from './footprint.mjs';
import { renderReport } from '../../internal-audit.mjs';
import { runPaymentRules } from './rules-payments.mjs';
const patterns = JSON.parse(await fs.readFile(new URL('../../internal-audit-patterns.json', import.meta.url)));
const generic = patterns.generic_partner_names[0], limit = patterns.thresholds.unregistered_min;
const base = () => ({ version: 1, fetchedAt: '2026-10-23', window: { start: '2026-07-25', end: '2026-10-23' }, partners: [{ id: 'g', name: generic }], payments: [{ id: 'p', partner_id: 'g', date: '2026-10-01', amount: limit }], wallet_txns: [], deals: [], walletables: [], account_items: [] });
const healthy = () => Object.fromEntries(['payee-sheet:old','payee-sheet:paypay','payee-sheet:form','purchasing'].map(k => [k, { status: 'ok', count: 1 }]));
const transfer = (extra = {}) => ({ date: '2026-10-01', amount: limit, name: '株式会社検証', source: 'old', category: '支払請求書', ...extra });
test('date/amount normalization rejects invalid dates and handles Japanese/ISO/serial', () => {
  assert.equal(sheetDate('2026年10月01日'), '2026-10-01'); assert.equal(sheetDate('2026/10/01 12:00'), '2026-10-01');
  assert.equal(sheetDate('2026-10-01T12:00:00Z'), '2026-10-01'); assert.equal(sheetDate('2026/13/40'), ''); assert.equal(sheetDate('2026/02/30'), '');
});
test('schedule header and bank reversed recipient columns preserve amount but omit all account data', () => {
  const header = ['振込予定日','振込先','依頼金額（円）','二重チェック','freee','取引先（名前・会社名）','copy','業務内容'];
  const bank = '1234567';
  const rows = parseSheetRows([[],[],[],header,['2026年10月01日',`普通 ${bank} テスト`,'1,234,567','','','検証','','当月払い']], { kind: 'old', tab: '202610' });
  assert.equal(rows[0].amount, 1234567); assert.equal(rows[0].doubleCheck, ''); assert.ok(!JSON.stringify(rows).includes(`普通 ${bank}`));
  for (const swap of [false,true]) {
    const h = ['振込指定日(年)','振込指定日(月)','振込指定日(日)',swap?'依頼人名':'受取人名',swap?'受取人名':'依頼人名','振込金額(円)','振込状況'];
    const r = ['2026','10','1',swap?'自社':'業者',swap?'業者':'自社','100000','受付済'];
    const parsed = parseSheetRows([h,r], { kind: 'paypay', tab: '202610' });
    assert.equal(parsed[0].name, '業者'); assert.equal(parsed[0].doubleCheck, null);
    r[6]='取消'; assert.equal(parseSheetRows([h,r], { kind: 'paypay', tab: '202610' }).length, 0);
  }
  assert.equal(parseSheetRows([['1','','','','7654321','名前','100000']], { kind: 'paypay', tab: '1005前倒し' }).length, 0);
});
test('form second header supplies requester and handler, date is completion not timestamp', () => {
 const h1=['','対応完了日','タイムスタンプ','依頼者','支払合計金額'];
 const h2=['対応者名前（プルダウン）','対応完了日','タイムスタンプ','担当者(依頼者)','支払合計金額'];
 const r=parseSheetRows([h1,h2,['対応者','2026/10/01','2026/08/01','依頼者','50,000']],{kind:'form',tab:'購買依頼フォーム'});
 assert.equal(r[0].date,'2026-10-01');assert.equal(r[0].handler,'対応者');assert.equal(r[0].name,'依頼者');
});
test('wallet kana/corporate cleanup rejects batch withdrawals, fees and empty descriptions', () => {
  assert.equal(extractPayee('振込 ｶ)ｼｰｸﾘｰ'), 'シークリー'); assert.equal(extractPayee('ニシオレントオ-ル(ｶ'), 'ニシオレントオ-ル');
  for (const s of ['WEB総振','振込','振込手数料','','1234567','WEB 総振 受付']) assert.equal(extractPayee(s), '');
});
test('ordered resolution a>b>c>d, boundary dates, nearest of multiple matches is ambiguous', () => {
 const s=base();s.wallet_txns=[{date:'2026-10-01',amount:limit,description:'ｶ)口座業者'}];
 const purchasing={purchase_records:[{date:'unused',created_at:'2026-10-01T00:00:00Z',amount:limit,vendor_name:'DB業者',created_by:'u'}],users:[{id:'u',name:'担当'}]};
 const opts={patterns,purchasing,sheetRows:[transfer({date:'2026-10-08'}),transfer({date:'2026-10-02',name:'最近業者'}),transfer({source:'form',name:'申請者'})]};
 let r=resolvePayees(s,opts);assert.equal(r.payments[0].name,'最近業者');assert.equal(r.payments[0].ambiguous,true);assert.equal(r.payments[0].resolved_by,'a');
 opts.sheetRows=opts.sheetRows.filter(r=>r.source==='form');r=resolvePayees(s,opts);assert.equal(r.payments[0].resolved_by,'b');
 s.wallet_txns=[];r=resolvePayees(s,opts);assert.equal(r.payments[0].resolved_by,'c');assert.equal(r.payments[0].evidence.handler,'担当');
 opts.purchasing={};r=resolvePayees(s,opts);assert.equal(r.payments[0].resolved_by,'d');
 opts.sheetRows=[];assert.equal(resolvePayees(s,opts).payments[0].status,'unresolved');
 for(const [days,date] of [[7,'2026-10-08'],[5,'2026-10-06'],[14,'2026-10-15']]){assert.ok(closest([transfer({date})],s.payments[0],days));assert.equal(closest([transfer({date})],s.payments[0],days-1),null);}
 assert.equal(closest([transfer({amount:limit+1})],s.payments[0],14),null);
});
test('cases match purchase or completion date and do not use cancelled requests', () => {
 const s=base(), c={budget:limit,requester:'申請者',purchase_date:'2026-08-01',complete_at:'2026-10-01'};
 assert.equal(resolvePayees(s,{patterns,purchasing:{cases:[c]}}).payments[0].resolved_by,'c');
 assert.equal(resolvePayees(s,{patterns,purchasing:{cases:[{...c,status:'cancelled'}]}}).payments[0].status,'unresolved');
});
test('other payments are internal only for the authoritative reimbursement categories', () => {
 for(const extra of [{category:'当月払い'},{category:'立替経費'},{category:'給与追加'}]){
 const r=resolvePayees(base(),{patterns,sheetRows:[transfer(extra)],staff:extra.staff,purchasing:{users:extra.users}});
 assert.equal(r.payees[0].internal,true);
 }
 assert.equal(resolvePayees(base(),{patterns,sheetRows:[transfer({category:'',name:'不明個人'})]}).payees[0].internal,false);
});
test('DB injection reads four explicit SELECTs only; no freee_tokens or secret columns', async () => {
 const calls=[];const db=await collectPurchasing({query:async q=>{calls.push(q);return q.includes('FROM users')?[{id:'u',name:'担当'}]:[];}});
 assert.equal(db.users.length,1);assert.equal(calls.length,4);assert.ok(calls.every(q=>/^SELECT /.test(q)&&!/(freee_tokens|card_last4|note|\*)/.test(q)));
 await assert.rejects(collectPurchasing({query:async()=>({})}),/応答不正/);
});
test('Sheets fetch injection enforces GET/read-only scope; 7-day cache expires; failure is not cached',async t=>{
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'ia-sheets-'));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));let calls=0,fail=false;
 const fetchImpl=async(url,options)=>{calls++;assert.equal(options.method,'GET');if(fail)return{ok:false,status:403};const u=new URL(url);const kind=Object.entries(PAYEE_SHEETS).find(([,id])=>u.pathname.includes(id))[0];const form=kind==='form';
 const h=form?['対応者名前','対応完了日','依頼者','支払合計金額']:['振込予定日','依頼金額','取引先(名前・会社名)','二重チェック'];
 return{ok:true,json:async()=>u.pathname.endsWith('values:batchGet')?{valueRanges:u.searchParams.getAll('ranges').map(()=>({values:[h,form?['担当','2026/10/01','依頼者',limit]:['2026/10/01',limit,'業者','']]}))}:{sheets:[{properties:{title:form?'購買依頼フォーム':'202610',gridProperties:{columnCount:4,rowCount:5}}}]}};};
 const google={getToken:async o=>{assert.match(o.scope,/spreadsheets.readonly$/);return'test';}};
 const opts={stateDir,google,fetchImpl,now:new Date('2026-10-01')};const first=await collectPayeeSheets(opts);assert.equal(first.rows.length,3);assert.ok(first.rows.some(r=>r.source==='form'));
 const n=calls;assert.equal((await collectPayeeSheets({...opts,now:new Date('2026-10-07')})).cached,true);assert.equal(calls,n);
 fail=true;const failed=await collectPayeeSheets({...opts,now:new Date('2026-10-08')});assert.ok(Object.values(failed.sources).every(s=>s.status==='failed'));
 fail=false;await collectPayeeSheets({...opts,now:new Date('2026-10-08')});assert.ok(calls>n);
});
test('source summary excludes generic/short/skip; partial/all failed/zero controls retain honest status',async t=>{
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'ia-sum-'));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
 const partners=[{id:'g',name:generic},{id:'s',name:'一'},{id:'a',name:'Alpha'},{id:'b',name:'Beta'}];
 let fp=await buildFootprint(partners,{stateDir,patterns,sources:{gmail:async n=>n==='Alpha'?{status:'ok',count:1}:{status:'failed',count:null,reason:'HTTP 403'}}});
 let s=summarizeFootprint(partners,fp,patterns);assert.equal(s.gmail.status,'partial');assert.equal(s.gmail.eligible,2);assert.equal(s.gmail.failed,1);assert.equal(s.drive.eligible,0);
 fp.b.gmail={status:'ok',count:0};assert.equal(summarizeFootprint(partners,fp,patterns).gmail.status,'ok');
 fp.a.gmail={status:'failed',count:null};fp.b.gmail={status:'unverified',count:0};assert.equal(summarizeFootprint(partners,fp,patterns).gmail.status,'failed');
 const snapshot=base();snapshot.footprint=fp;assert.equal(footprintExclusions(snapshot,patterns)[0].amount,limit);
});
test('R16 threshold and positive-control/failed-source protection; R17 normalized approval; R18 monthly-only applicable rows',()=>{
 const s=base();s.payments.push({id:'q',partner_id:'g',date:'2026-10-02',amount:limit-1},{id:'r',partner_id:'g',date:'2026-10-03',amount:limit+1});
 s.payeeResolution=resolvePayees(s,{patterns,sheetRows:[transfer({amount:limit+1})],sources:healthy()});
 let r=runPayeeRules(s,patterns);assert.equal(r.findings.filter(f=>f.rule==='R16'&&f.severity==='medium').length,1);assert.equal(r.findings.filter(f=>f.rule==='R16'&&f.severity==='info').length,1);
 s.payeeResolution.sources.purchasing.status='failed';assert.equal(runPayeeRules(s,patterns).findings.filter(f=>f.rule==='R16').length,0);
 s.purchasing={users:[{id:'u',name:'山田 太郎',email:'taro@example.invalid'}],cases:[{id:'c',requester:'山田太郎',self_purchase_approved_by:'TARO@example.invalid',self_purchase_approved_at:'2026-10-02',item_summary:'対象'},{id:'other',requester:'別人',self_purchase_approved_by:'taro@example.invalid',created_at:'2026-10-02'}],purchase_records:[{case_id:'a',amount:100000,created_at:'2026-10-02'},{case_id:'b',amount:99999,created_at:'2026-10-02'},{case_id:'c',amount:100000,created_at:'2026-10-02'}],approvals:[{case_id:'c'}]};
 s.payeeSheetRows=[transfer({date:'2026-10-01',amount:100000,doubleCheck:''}),transfer({date:'2026-10-02',amount:200000,doubleCheck:''}),transfer({amount:99999,doubleCheck:''}),transfer({amount:200000,doubleCheck:'○'}),transfer({amount:200000,doubleCheck:null}),transfer({amount:200000,doubleCheck:'',date:'2025-10-01'})];
 r=runPayeeRules(s,patterns);assert.equal(r.findings.filter(f=>f.rule==='R17'&&f.severity==='medium').length,1);assert.equal(r.findings.filter(f=>f.rule==='R17'&&f.severity==='info').length,1);assert.equal(r.findings.filter(f=>f.rule==='R18').length,1);assert.match(r.findings.find(f=>f.rule==='R18').detail,/2件.*300000/);
});
test('R02 resolved vendor requires all controlled zeros and unambiguous identity; internal names excluded',()=>{
 const s=base();s.payeeResolution=resolvePayees(s,{patterns,sheetRows:[transfer()],sources:healthy()});const p=s.payeeResolution.payees[0];
 s.footprint={[p.id]:Object.fromEntries(['gmail','drive','discord'].map(k=>[k,{status:'ok',count:0,controlVerified:true}]))};
 assert.equal(runPayeeRules(s,patterns).findings.filter(f=>f.rule==='R02').length,1);
 s.footprint[p.id].gmail.controlVerified=false;assert.equal(runPayeeRules(s,patterns).findings.filter(f=>f.rule==='R02').length,0);
 s.footprint[p.id].gmail.controlVerified=true;p.ambiguous=true;assert.equal(runPayeeRules(s,patterns).findings.filter(f=>f.rule==='R02').length,0);
 p.ambiguous=false;p.internal=true;assert.equal(runPayeeRules(s,patterns).findings.filter(f=>f.rule==='R02').length,0);
});
test('R10 report aggregates by wallet and shows ten largest only; full findings remain intact',()=>{
 const s=base();s.walletables=[{id:'w',type:'bank',name:'検証口座'}];
 s.wallet_txns=Array.from({length:15},(_,i)=>({id:String(i),walletable_id:'w',walletable_type:'bank',entry_side:'expense',date:'2026-08-01',status:1,amount:limit+i}));
 const r=runPaymentRules(s,{},patterns);const report=renderReport({snapshot:s,...r,sources:{},patterns});
 assert.equal(r.findings.filter(f=>f.rule==='R10').length,15);assert.match(report,/明細あり・取引未登録（freee 消込待ち）/);assert.match(report,/検証口座 \| 明細あり・取引未登録 \| 15/);
 assert.equal(report.split('\n').filter(l=>l.startsWith('| medium | 検証口座')).length,10);
 assert.ok(!report.includes(`2026-08-01 ${limit}円`));assert.ok(report.includes(`2026-08-01 ${limit+14}円`));
});
test('payee table overflow is 200 rows including JSONL pointer; amounts never look like account numbers',()=>{
 const s=base();s.payeeResolution={summary:[],payments:[],payees:Array.from({length:205},(_,i)=>({id:`p${i}`,name:`業者${i}`,count:1,amount:1234567,classifications:['業者'],categories:[],resolved_by:['a']}))};
 const report=renderReport({snapshot:s,findings:[],sources:{gmail:{status:'partial',eligible:3,failed:1}},patterns});
 assert.equal(report.split('\n').filter(l=>l.startsWith('| 業者')).length,199);assert.match(report,/他 6行/);assert.match(report,/payees.jsonl/);assert.match(report,/1,234,567円/);assert.ok(!/\d{7,}/.test(report));assert.match(report,/一部失敗（1\/3 社）/);
});

test('Rakuten ordinary-deposit account and appended request metadata never become the payee name', () => {
 const raw='検証銀行 支店 普通預金 123456 検証受取人(依頼人名:自社 振込予定日:2026年10月01日 管理番号:123456789)';
 const rows=parseSheetRows([['2026年10月01日',raw,'100000']],{kind:'paypay',tab:'楽天履歴'});
 assert.equal(rows[0].name,'検証受取人'); assert.ok(!JSON.stringify(rows).includes('123456'));
});
test('unique historical bank-name mapping resolves kana to roster identity; conflicting aliases stay unverified', () => {
 const s=base();const old=transfer({date:'2025-01-01',name:'検証担当',bankName:'ケンシヨウ タントウ',category:'給与'});
 const current=transfer({source:'paypay',name:'ケンショウタントウ',category:''});
 let r=resolvePayees(s,{patterns,sheetRows:[old,current],staff:[{names:['検証 担当']}]});
 assert.equal(r.payments[0].name,'検証担当');assert.equal(r.payees[0].internal,false);assert.equal(r.payments[0].evidence.nameReference.source,'old');
 r=resolvePayees(s,{patterns,sheetRows:[old,{...old,name:'別人'},current],staff:[{names:['検証 担当']}]});
 assert.equal(r.payments[0].name,'ケンショウタントウ');assert.equal(r.payees[0].internal,false);
});
test('R10 minimum severity filters visible rows and each wallet has one summary across statuses',()=>{
 const s=base();s.walletables=[{id:'w',type:'bank',name:'検証口座'}];s.wallet_txns=[{id:'a',walletable_id:'w',walletable_type:'bank',entry_side:'expense',date:'2026-08-01',status:1,amount:limit},{id:'b',walletable_id:'w',walletable_type:'bank',entry_side:'expense',date:'2026-08-01',status:3,amount:patterns.thresholds.ignored_min}];
 const r=runPaymentRules(s,{},patterns);
 const report=renderReport({snapshot:s,...r,sources:{},patterns});assert.equal(report.split('\n').filter(l=>l.startsWith('| 検証口座 |')).length,1);
 const high=renderReport({snapshot:s,...r,sources:{},patterns,minSeverity:'high'});assert.ok(!high.includes('| medium | 検証口座'));assert.ok(!high.includes('| info | 検証口座'));
});

test('timestamp dates use JST and corporate names cannot borrow a similarly named staff identity',()=>{
 assert.equal(sheetDate('2026-09-30T16:00:00Z'),'2026-10-01');
 const s=base();const r=resolvePayees(s,{patterns,sheetRows:[transfer({name:'株式会社検証担当',category:''})],staff:[{names:['検証担当']}]});
 assert.equal(r.payees[0].internal,false);assert.equal(r.payments[0].classification,'業者');
});

test('public numeric ports do not corrupt dates while credential values are still scrubbed',async t=>{
 const {envSecretValues,writePrivate,readJson}=await import('./common.mjs');
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ia-secret-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
 const secret='test-password-only',values=envSecretValues({YAHOO_IMAP_PORT:'993',OTHER_PORT:'443',DATABASE_URL:'postgres://fixture.invalid/db',PASSWORD:secret});
 assert.ok(!values.includes('993'));assert.ok(!values.includes('443'));assert.ok(values.includes(secret));
 const file=path.join(dir,'state.json');await writePrivate(file,{modifiedCursor:'2026-10-09T08:09:11.993Z',detail:secret},values);
 const state=await readJson(file);assert.equal(state.modifiedCursor,'2026-10-09T08:09:11.993Z');assert.ok(!state.detail.includes(secret));
});

test('resolved generic names are exclusions rather than the old unverified R02; unavailable double-check columns stay unverified',()=>{
 const s=base();s.payeeResolution=resolvePayees(s,{patterns,sheetRows:[transfer()],sources:healthy()});
 assert.equal(runPaymentRules(s,{},patterns).unverified.filter(r=>r.rule==='R02'&&r.subject===generic).length,0);
 assert.ok(runPayeeRules(s,patterns).unverified.some(r=>r.rule==='R18'));
 s.payeeSheetRows=[transfer({doubleCheck:'○'})];assert.ok(!runPayeeRules(s,patterns).unverified.some(r=>r.rule==='R18'));
 delete s.payeeResolution;assert.ok(runPaymentRules(s,{},patterns).unverified.some(r=>r.rule==='R02'&&r.subject===generic));
});


test('wallet Rakuten extracts only recipient for masked/plain accounts and fullwidth metadata', () => {
 for (const [raw, expected] of [
  ['三菱UFJ銀行 横浜駅前支店 普通預金 ****8104 サトウ シユンスケ(依頼人名:自社 振込予定日:2026年09月30日)', 'サトウ シユンスケ'],
  ['検証信用金庫 本店 当座 1234567 ｶ)ﾃｽﾄ（依頼人名：自社）', 'テスト'],
  ['検証信用組合 横浜支店 貯蓄 ＊＊＊＊１２３４ タナカ ハナコ（依頼人名:自社）', 'タナカ ハナコ'],
 ]) assert.equal(extractPayee(raw, patterns), expected);
 for (const bank of ['ゆうちょ銀行','PayPay銀行','楽天銀行']) assert.equal(extractPayee(`${bank} 本店 普通 *1234 テスト(依頼人名:自社)`,patterns),'テスト');
 for (const raw of ['WEB 総振','振込手数料','カード利用','ATM 出金','ＡＴＭ','1234567']) assert.equal(extractPayee(raw,patterns),'');
 assert.equal(extractPayee('独自除外',{non_payee_tokens:['独自除外']}),'');
 assert.equal(extractPayee('普通の商店',patterns),'普通の商店');
});

test('all three generic partners × sources a/b/c/d obey freee category, regardless of roster/corporate name', () => {
 for (const [id,name,label] of [['104096614','アシスタント','社内（アシスタント）'],['104055245','当月払い','社内（当月払い・立替）'],['114448264','その他','業者']]) {
  for (const method of ['a','b','c','d']) {
   const s=base();s.partners=[{id,name}];s.payments[0].partner_id=id;
   const opts={patterns,staff:[{names:['検証']}]};
   if(method==='a') opts.sheetRows=[transfer()];
   if(method==='b') s.wallet_txns=[{date:'2026-10-01',amount:limit,description:'振込 カ)検証'}];
   if(method==='c') opts.purchasing={purchase_records:[{created_at:'2026-10-01',amount:limit,vendor_name:'株式会社検証'}]};
   if(method==='d') opts.sheetRows=[transfer({source:'form'})];
   const r=resolvePayees(s,opts);assert.equal(r.payments[0].resolved_by,method);assert.equal(r.payees[0].classification,label);
   assert.equal(r.payees[0].internal,id!=='114448264');
  }
 }
});

test('same recipient internal and vendor amounts remain separate; no internal adapter calls', async t => {
 const s=base();s.partners.push({id:'104096614',name:'アシスタント'});s.payments.push({...s.payments[0],id:'second',partner_id:'104096614'});
 const r=resolvePayees(s,{patterns,sheetRows:[transfer()]});assert.equal(r.payees.length,2);assert.equal(r.payees.find(p=>!p.internal).amount,limit);
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'ia-internal-'));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
 let calls=0;await buildFootprint(r.payees.filter(p=>p.internal),{stateDir,sources:{gmail:async()=>{calls++;return{status:'ok',count:0};}}});assert.equal(calls,0);
});

test('kana aliases precede freee name_kana reverse lookup; variants normalize small kana, dash, width, spacing', () => {
 assert.equal(normalizeKana('ﾖｺﾊﾏ ｽﾃ−ｼﾞﾌﾟﾗﾝ(ｶ'),'ヨコハマステージプラン');
 const partners=[{name:'横浜ステージプラン',name_kana:'ﾖｺﾊﾏｽﾃｰｼﾞﾌﾟﾗﾝ'}];
 assert.deepEqual(payeeSearch('ヨコハマステ−ジプラン(カ',patterns,partners).searchTerms,['横浜ステージプラン']);
 const aliases={...patterns,kana_vendor_aliases:{'ヨコハマステージプラン':['横浜舞台','株式会社横浜演出']}};
 assert.deepEqual(payeeSearch('ヨコハマステ−ジプラン(カ',aliases,partners).searchTerms,['横浜舞台','横浜演出']);
 assert.equal(payeeSearch('カナノミ',patterns,partners).kanaUnverified,true);
 for(const name of ['ダイ30カイ.ガツカイ','テスト・カイシヤ']) assert.equal(payeeSearch(name,patterns).kanaUnverified,true);
 assert.deepEqual(payeeSearch('アサヒロジステイクス',patterns,[{name:'アサヒロジスティクス',name_kana:'アサヒロジスティクス'}]).kanaUnverified,true);
 assert.deepEqual(payeeSearch('アサヒロジステイクス',{kana_vendor_aliases:{'アサヒロジスティクス':['旭物流']}}).searchTerms,['旭物流']);
});

test('kana zero is unverified, positive hits suppress it; alias/reverse lookup controlled zeros can trigger R02', () => {
 for (const mapped of ['none','alias','freee']) {
  const s=base(),custom=mapped==='alias'?{...patterns,kana_vendor_aliases:{'テスト':['検証商店']}}:patterns;
  if(mapped==='freee')s.partners.push({id:'vendor',name:'検証商店',name_kana:'ﾃｽﾄ'});
  s.payeeResolution=resolvePayees(s,{patterns:custom,sheetRows:[transfer({name:'テスト',category:''})]});const p=s.payeeResolution.payees[0];
  s.footprint={[p.id]:Object.fromEntries(['gmail','drive','discord'].map(k=>[k,{status:'ok',count:0,controlVerified:true,queriedTerms:p.searchTerms}]))};
  const r=runPayeeRules(s,custom);assert.equal(r.findings.filter(f=>f.rule==='R02').length,mapped==='none'?0:1);
  if(mapped==='none')assert.match(r.unverified.find(f=>f.rule==='R02').detail,/カナ名義のため照合精度低/);
  s.footprint[p.id].gmail.count=1;assert.ok(!runPayeeRules(s,custom).unverified.some(f=>f.rule==='R02'));
 }
});

test('multiple alias queries reach every adapter, cache invalidates changes, report lists actual terms only', async t => {
 const stateDir=await fs.mkdtemp(path.join(os.tmpdir(),'ia-alias-'));t.after(()=>fs.rm(stateDir,{recursive:true,force:true}));
 const p={id:'p',name:'テスト',...payeeSearch('テスト',{kana_vendor_aliases:{'テスト':['検証商店','検証工房']}})};
 const calls=[],sources=Object.fromEntries(['gmail','drive','discord'].map(k=>[k,async term=>{calls.push([k,term]);return{status:'ok',count:2};}]));
 const opts={stateDir,sources,now:new Date('2026-10-23')};
 let fp=await buildFootprint([p],opts);assert.equal(calls.length,6);assert.equal(fp.p.gmail.count,2);assert.deepEqual(fp.p.discord.queriedTerms,p.searchTerms);
 await buildFootprint([p],opts);assert.equal(calls.length,6);
 p.searchTerms=['別商店'];fp=await buildFootprint([p],opts);assert.equal(calls.length,9);assert.deepEqual(fp.p.gmail.queriedTerms,['別商店']);
 const s=base();s.footprint=fp;s.payeeResolution={summary:[],payments:[],payees:[{...p,classification:'業者',count:1,amount:limit,resolved_by:['b']}]};
 const report=renderReport({snapshot:s,findings:[],sources:{},patterns});assert.match(report,/検索語（実際に使用）/);assert.match(report,/gmail: 別商店/);assert.ok(!report.includes('gmail: テスト'));
});

test('offline replay preserves matching query results, invalidates changed aliases and partial variants', () => {
 const s=base();s.fetchedAt='2026-10-23T10:00:00Z';s.window.days=90;
 const old={id:'p',name:'テスト'},zeros=Object.fromEntries(['gmail','drive','discord'].map(k=>[k,{status:'ok',count:0,controlVerified:true}]));
 s.footprint={p:zeros};s.payeeResolution={payees:[{...old,...payeeSearch('テスト',patterns)}]};
 replayResolvedFootprint(s,[old]);assert.equal(s.footprint.p.gmail.status,'ok');assert.deepEqual(s.footprint.p.gmail.queriedTerms,['テスト']);
 s.payeeResolution.payees[0].searchTerms=['検証商店'];replayResolvedFootprint(s,[old]);assert.equal(s.footprint.p.gmail.status,'unverified');assert.deepEqual(s.footprint.p.gmail.queriedTerms,[]);
 const cached={a:{term:'検証商店',window:90,at:s.fetchedAt,results:zeros}};
 replayResolvedFootprint(s,[old],cached);assert.equal(s.footprint.p.gmail.status,'ok');assert.deepEqual(s.footprint.p.gmail.queriedTerms,['検証商店']);
 s.payeeResolution.payees[0].searchTerms=['検証商店','検証工房'];replayResolvedFootprint(s,[old],cached);assert.equal(s.footprint.p.gmail.status,'unverified');assert.equal(s.footprint.p.gmail.controlVerified,false);
});
