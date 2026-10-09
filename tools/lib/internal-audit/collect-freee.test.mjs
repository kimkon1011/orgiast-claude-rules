import test from 'node:test';
import assert from 'node:assert/strict';
import { collectFreee, normalizeFreee, COMPANY_ID, getReadOnlyToken } from './collect-freee.mjs';
import { getJson, scrub } from './common.mjs';
const now=new Date('2026-10-09T00:00:00Z');
test('freee GET pagination, company, paid-only and masked stable bank equality',async()=>{
 const calls=[];
 const fetchImpl=async(u,opts)=>{const url=new URL(u);calls.push([url,opts]);const type=url.pathname.split('/').at(-1),offset=+url.searchParams.get('offset');
 const p={id:1,name:'Sample',partner_bank_account_attributes:{bank_code:'TEST',branch_code:'TEST',account_number:'TESTACCOUNT',account_name:'Sample'}};
 const data={partners:offset===0?Array.from({length:100},(_,i)=>({...p,id:i})):[],deals:[{id:1,type:'expense',amount:900,partner_id:1,issue_date:'2026-10-01',payments:[{id:2,date:'2026-10-02',amount:100}]}],wallet_txns:[],walletables:[],account_items:[]};return{ok:true,json:async()=>({[type]:data[type]})};};
 const s=await collectFreee({token:'secret',now,fetchImpl});assert.equal(s.partners.length,100);assert.equal(s.payments.length,1);assert.equal(s.payments[0].amount,100);assert.equal(s.partners[0].bank.account_number,'****OUNT');assert.equal(s.partners[0].bank.key,s.partners[1].bank.key);
 assert.ok(!JSON.stringify(s).includes('TESTACCOUNT'));assert.ok(calls.every(([u,o])=>u.searchParams.get('company_id')===String(COMPANY_ID)&&o.method==='GET'&&o.signal));assert.equal(calls.filter(([u])=>u.pathname.endsWith('partners')).length,2);
});
test('retry 429 respects retry_after then 5xx backs off, finite retries',async()=>{
 const waits=[];let calls=0;
 const result=await getJson('https://example.invalid',{fetchImpl:async()=>{calls++;return calls<3?{ok:false,status:calls===1?429:500,headers:new Headers(),json:async()=>({retry_after:3})}:{ok:true,json:async()=>({ok:1})};},sleep:async ms=>waits.push(ms)});
 assert.equal(result.ok,1);assert.deepEqual(waits,[3000,2000]);
 let n=0;await assert.rejects(getJson('https://example.invalid',{fetchImpl:async()=>{n++;return{ok:false,status:500,headers:new Headers()};},sleep:async()=>{}}));assert.equal(n,6);
});
test('missing database never refreshes credentials; scrub strips forbidden fields',async()=>{
 await assert.rejects(getReadOnlyToken(''),/freee 未接続/);assert.deepEqual(scrub({body:'secret',snippet:'secret',private_key:'secret',access_token:'secret',account_number:'TESTACCOUNT'}),{account_number:'****OUNT'});
});
