import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TEMA_RULE_HEADINGS, absoluteTemaStep, buildBeacon } from './fleet-beacon.mjs';
import { buildFleetStatus, formatFleetTable } from './fleet-status.mjs';
import { buildTemaRollout, formatTemaRollout, main } from './tema-rollout-check.mjs';
const now=Date.parse('2026-11-27T12:00:00+09:00');
test('見出し定数はONBOARDING正本と一致',()=>{
 const body=fs.readFileSync(new URL('../ONBOARDING.md',import.meta.url),'utf8');
 for(const heading of Object.values(TEMA_RULE_HEADINGS))assert.ok(body.includes(`**${heading}（`));
});
test('絶対ルールのブロック内だけを読み、3見出しとカード注意欠落はfail',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'tema-rules-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 assert.equal(absoluteTemaStep(home).status,'fail');fs.mkdirSync(path.join(home,'.claude'));
 const file=path.join(home,'.claude','CLAUDE.md');
 for(const missing of [null,...Object.keys(TEMA_RULE_HEADINGS)]){
  const text=Object.entries(TEMA_RULE_HEADINGS).filter(([k])=>k!==missing).map(([,v])=>v).join('\n');
  fs.writeFileSync(file,`<!-- BEGIN: 絶対ルール (自動同期・編集しても上書きされる) -->\n${text}\n送信済みなのでカードは押さないで\n<!-- END: 絶対ルール -->\n${Object.values(TEMA_RULE_HEADINGS).join('\n')}`);
  const step=absoluteTemaStep(home);assert.equal(step.status,missing?'fail':'ok');
  assert.equal(buildBeacon({home,label:'008',identity:{},now}).steps.filter(s=>s.id==='absolute-rules-tema').length,1);
 }
});
test('4状態×4列、fleet-statusにも同じ結果',()=>{
 const pcMap={'001':{},'002':{},'003':{},'004':{},_note:'除外'};
 const beacons=[{label:'001',reportedAt:new Date(now).toISOString(),steps:[{id:'absolute-rules-tema',status:'ok',reason:'tema=yes; signin=yes; consistency=yes; card=yes'}]}, {label:'002',reportedAt:new Date(now).toISOString(),steps:[{id:'absolute-rules-tema',status:'fail',reason:'tema=yes; signin=no; consistency=no'}]}, {label:'003',reportedAt:new Date(now).toISOString(),steps:[]}];
 const rows=buildTemaRollout({pcMap,beacons,now});assert.deepEqual(rows.map(r=>r.state),['反映済み','未反映','未報告＝旧版ビーコン','オフライン']);
 assert.deepEqual(rows.map(({tema,signin,consistency})=>[tema,signin,consistency]),[[true,true,true],[true,false,false],[null,null,null],[null,null,null]]);
 const status=buildFleetStatus({pcMap,beacons,now});assert.equal(status[0].temaRules.consistency,true);assert.match(formatFleetTable(status),/手間ルール: tema=yes\/signin=yes\/consistency=yes/);
 assert.match(formatTemaRollout(rows),/手間チェック \| サインイン委任 \| 整合性チェック/);
 beacons[0].reportedAt=new Date(now-86400001).toISOString();assert.equal(buildTemaRollout({pcMap,beacons,now})[0].state,'オフライン');
});
test('CLI --json --outはBOMなし、APIはモック',async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'rollout-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const file=path.join(home,'result.json');
 const code=await main(['--json','--out',file],{pcMap:{'008':{}},fetchBeacons:async()=>({ok:true,beacons:[]}),now,stdout:()=>{}});
 assert.equal(code,0);assert.equal(JSON.parse(fs.readFileSync(file,'utf8'))[0].state,'オフライン');assert.notEqual(fs.readFileSync(file)[0],0xef);
});
