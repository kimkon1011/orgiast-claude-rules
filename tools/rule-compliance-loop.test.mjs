import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs';
import { decideRuleEnforcement, makeReport } from './rule-compliance-loop.mjs';
const registry=JSON.parse(fs.readFileSync(new URL('./rules-registry.json',import.meta.url),'utf8')); const catalog=JSON.parse(fs.readFileSync(new URL('./automation-routes.json',import.meta.url),'utf8'));
test('6 未検証ならすり抜けがあってもoff',()=>assert.equal(decideRuleEnforcement({...registry.rules[0],validation:{status:'unvalidated',precision:null,minPrecision:.9}},{bypass:1,violation:1,examples:[]}).mode,'off'));
test('6b 検証済みならすり抜け1件で即block',()=>assert.equal(decideRuleEnforcement({...registry.rules[0],validation:{status:'validated',precision:.95,minPrecision:.9}},{bypass:1,violation:1,examples:[]}).mode,'block'));
test('6c ledgerなしは計測不能',()=>{const results=Object.fromEntries(registry.rules.map(r=>[r.id,{applicable:0,violation:0,bypass:0,examples:[]}]));const enforcement=Object.fromEntries(registry.rules.map(r=>[r.id,{mode:'off',reason:'検出器未検証（精度 未計測）'}]));assert.match(makeReport(registry,results,enforcement,7,{ledgerAvailable:false}),/すり抜け: 計測不能（ledger 未生成）/);});
test('8 登録簿の必須フィールド',()=>{ assert.equal(registry.rules.length,5); for(const r of registry.rules){assert.ok(r.detect);if(r.detect.mode==='delegated'){assert.ok(r.owner);assert.equal(r.enforcement,'off');continue;}assert.ok(r.gate);assert.ok(r.thresholds);assert.ok(r.validation);} });
test('9 自動化経路の全カテゴリが空でない',()=>{for(const routes of Object.values(catalog)) assert.ok(Array.isArray(routes)&&routes.length>0);});
