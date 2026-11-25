import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runPaymentRules, normalizeAccount } from './rules-payments.mjs';
const patterns = JSON.parse(fs.readFileSync(new URL('../../internal-audit-patterns.json', import.meta.url)));
const sample = JSON.parse(fs.readFileSync(new URL('../../fixtures/internal-audit/snapshot.sample.json', import.meta.url)));
const t = patterns.thresholds;
function base() { return { ...structuredClone(sample), partners:[{id:'p',name:'テスト',name_kana:'テスト',bank:{}}],payments:[],deals:[],baseline:{knownPartnerIds:['p']},footprint:{},staff:[] }; }
const pay = (amount, date='2026-10-01') => ({ partner_id:'p',date,amount });
const findings = (s,p=patterns) => runPaymentRules(s,s.footprint,p).findings;
const has = (s,r,p=patterns) => findings(s,p).some(f=>f.rule===r);
test('R01 recent unknown positive, known/old/low negative; missing creation unverified',()=>{
 const s=base();s.payments=[pay(t.new_partner_amount)];s.baseline.knownPartnerIds=[];assert.ok(has(s,'R01'));
 s.baseline.knownPartnerIds=['p'];assert.ok(!has(s,'R01'));delete s.baseline;
 assert.ok(runPaymentRules(s,{},patterns).unverified.some(f=>f.rule==='R01'));s.partners[0].created_at='2026-09-01';assert.ok(has(s,'R01'));s.partners[0].created_at='2026-01-01';assert.ok(!has(s,'R01'));
});
test('R02 all verified zero required; any hit/skip/failure cannot be high',()=>{
 const s=base();s.payments=[pay(t.no_footprint_high)];s.footprint.p=Object.fromEntries(['gmail','drive','discord'].map(k=>[k,{status:'ok',count:0,controlVerified:true}]));assert.equal(findings(s).find(f=>f.rule==='R02').severity,'high');
 s.footprint.p.gmail.count=1;assert.ok(!has(s,'R02'));s.footprint.p.gmail.count=0;s.footprint.p.discord.status='failed';assert.ok(!has(s,'R02'));assert.ok(runPaymentRules(s,s.footprint,patterns).unverified.some(f=>f.rule==='R02'));
});
test('R03 round amounts boundary',()=>{const s=base();s.payments=[pay(t.round_min)];assert.ok(has(s,'R03'));s.payments=[pay(t.round_min+1)];assert.ok(!has(s,'R03'));});
test('R04 approval lower bound and repeat severity',()=>{const s=base();s.payments=Array.from({length:t.repeat_count},()=>pay(t.approval[0]*t.approval_lower_ratio));assert.equal(findings(s).find(f=>f.rule==='R04').severity,'medium');s.payments.pop();assert.equal(findings(s).find(f=>f.rule==='R04').severity,'info');s.payments=[pay(t.approval[0])];assert.ok(!has(s,'R04'));});
test('R05 same vendor same amount within window only',()=>{const s=base();s.payments=[pay(123),pay(123,'2026-10-09')];assert.ok(has(s,'R05'));s.payments[1].date='2026-09-01';assert.ok(!has(s,'R05'));s.payments[1].date='2026-10-09';s.payments[1].partner_id='other';assert.ok(!has(s,'R05'));});
test('R06 bank identity cannot use last four alone',()=>{const s=base();s.partners=[{id:'a',name:'A',bank:{key:'one',account_number:'****TEST'}},{id:'b',name:'B',bank:{key:'one',account_number:'****TEST'}}];assert.ok(has(s,'R06'));s.partners[1].bank.key='two';assert.ok(!has(s,'R06'));});
test('R07 normalized kana comparison and no kana info',()=>{const s=base();s.payments=[pay(t.name_mismatch_amount)];s.partners[0].bank.account_name='カ）ベツ';assert.equal(findings(s).find(f=>f.rule==='R07').severity,'medium');s.partners[0].bank.account_name='ｶ) ﾃｽﾄ';assert.ok(!has(s,'R07'));s.partners[0].name='架空商店';delete s.partners[0].name_kana;assert.equal(findings(s).find(f=>f.rule==='R07').severity,'info');assert.equal(normalizeAccount('カ）テースト'),normalizeAccount('ﾃｽﾄ'));});
test('R08 company without corporate abbreviation only',()=>{const s=base();s.payments=[pay(1)];s.partners[0].name='株式会社テスト';s.partners[0].bank.account_name='テスト タロウ';assert.ok(has(s,'R08'));s.partners[0].bank.account_name='カ）テスト';assert.ok(!has(s,'R08'));});
test('R09 count, total and 7 day boundary',()=>{const s=base();s.payments=Array.from({length:t.repeat_count},()=>pay(t.approval[0]/t.repeat_count+1));assert.ok(has(s,'R09'));s.payments.pop();assert.ok(!has(s,'R09'));});
test('R10 status/age/amount/expense filters',()=>{const s=base();s.wallet_txns=[{entry_side:'expense',status:1,date:'2026-08-01',amount:t.unregistered_min}];assert.ok(has(s,'R10'));s.wallet_txns[0].status=2;assert.ok(!has(s,'R10'));s.wallet_txns[0].status=3;s.wallet_txns[0].amount=t.ignored_min;assert.equal(findings(s).find(f=>f.rule==='R10').severity,'info');s.wallet_txns[0].entry_side='income';assert.ok(!has(s,'R10'));});
test('R11 weekend and statutory holiday but not weekday',()=>{const s=base();s.payments=[pay(1,'2026-10-03')];assert.ok(has(s,'R11'));s.payments=[pay(1,'2026-09-22')];assert.ok(has(s,'R11'));s.payments=[pay(1,'2026-10-01')];assert.ok(!has(s,'R11'));});
test('R12 adequate sample only and Benford-consistent negative',()=>{const s=base();s.payments=Array.from({length:t.benford_min_count},()=>pay(111));assert.ok(has(s,'R12'));s.payments.pop();assert.ok(!has(s,'R12'));s.payments=Array.from({length:9},(_,i)=>Array.from({length:Math.round(1000*Math.log10(1+1/(i+1)))},()=>pay((i+1)*10))).flat();assert.ok(!has(s,'R12'));});
test('R13 exact member match; substring not sufficient',()=>{const s=base();s.payments=[pay(1)];s.staff=[{names:['テスト'],emails:[]}];assert.ok(has(s,'R13'));s.staff[0].names=['テスト以外'];assert.ok(!has(s,'R13'));s.partners[0].email='test@example.invalid';s.staff[0].emails=['test@example.invalid'];assert.ok(has(s,'R13'));});
test('R14 free mail exact domain only',()=>{const s=base();s.payments=[pay(1)];s.partners[0].email=`a@${t.free_mail_domains[0]}`;assert.ok(has(s,'R14'));s.partners[0].email='a@example.invalid';assert.ok(!has(s,'R14'));});
test('R15 full six months required and ratio strict',()=>{const s=base();s.payments=[pay(t.spike_min),pay(t.spike_min*t.spike_months/t.spike_ratio-1,'2026-04-01')];assert.ok(has(s,'R15'));s.payments[1].amount++;assert.ok(!has(s,'R15'));s.payments[1].amount--;s.coverage.historyComplete=false;assert.ok(!has(s,'R15'));});
test('allowlist suppresses only R02 R07 R08, inputs immutable',()=>{const s=structuredClone(sample),before=JSON.stringify(s);const custom={...patterns,allowlist_partners:['sample-a']};for(const r of ['R02','R07','R08'])assert.ok(!has(s,r,custom));assert.ok(has(s,'R05',custom));assert.ok(has(s,'R06',custom));assert.equal(JSON.stringify(s),before);});

test('payment agents normalize kana, lower R07 and exclude R08; unrelated bank remains high', () => {
  const s = base();
  s.partners[0].name = '株式会社テスト';
  s.partners[0].bank.account_name = 'ﾈｯﾄﾌﾟﾛﾃｸｼｮﾝｽﾞ ｶ)';
  s.payments = [pay(t.name_mismatch_amount)];
  assert.match(findings(s).find(f => f.rule === 'R07').detail, /収納代行経由（ネットプロテクションズ）/);
  assert.equal(findings(s).find(f => f.rule === 'R07').severity, 'info');
  assert.ok(!has(s, 'R08'));
  s.partners[0].bank.account_name = 'ベツジン';
  assert.equal(findings(s).find(f => f.rule === 'R07').severity, 'medium');
  assert.ok(has(s, 'R08'));
});
test('R13 personal contractor medium, corporate personal bank high with reciprocal R08 references', () => {
  const s = base(); s.payments = [pay(100)];
  s.partners[0].name = '川西美沙'; s.partners[0].name_kana = 'カワニシミサ';
  s.staff = [{ names: ['カワニシミサ'] }];
  assert.equal(findings(s).find(f => f.rule === 'R13').severity, 'medium');
  s.partners[0].name = '株式会社MUGUET'; s.partners[0].name_kana = 'ミュゲ';
  s.partners[0].bank.account_name = 'ｶﾜﾆｼ ﾐｻ';
  assert.equal(findings(s).find(f => f.rule === 'R13').severity, 'high');
  assert.match(findings(s).find(f => f.rule === 'R13').detail, /R08/);
  assert.match(findings(s).find(f => f.rule === 'R08').detail, /R13-high/);
  s.partners[0].bank.account_name = 'カ)カワニシミサ';
  assert.ok(!has(s, 'R13'));
});
test('generic partner cannot trigger R02 even with verified zeros', () => {
  const s = base(); s.partners[0].name = 'その他'; s.payments = [pay(500000)];
  s.footprint.p = Object.fromEntries(['gmail','drive','discord'].map(k => [k, { status: 'ok', count: 0, controlVerified: true }]));
  assert.ok(!has(s, 'R02'));
  assert.match(runPaymentRules(s, s.footprint, patterns).unverified.find(f => f.rule === 'R02').detail, /汎用取引先名/);
});
test('unregistered payments aggregate all amounts, keep threshold boundary; R15 is one row', () => {
  const s = base(); s.coverage.historyComplete = false;
  s.partners.push({ id: 'q', name: 'Another' });
  s.payments = [pay(1), { ...pay(1), partner_id: 'q' }, ...[145, 49999, 50000].map(amount => ({ ...pay(amount), partner_id: '' }))];
  const rows = runPaymentRules(s, {}, patterns).unverified;
  assert.equal(rows.filter(r => r.rule === 'R15').length, 1);
  const unknown = rows.filter(r => r.rule === 'payments');
  assert.equal(unknown.length, 2); assert.match(unknown[0].detail, /3件・合計 100144円/);
  assert.match(unknown[1].detail, /50000円/);
});
