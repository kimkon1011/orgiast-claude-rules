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
test('見出しとカード注意が絶対ルールブロックの外にあるだけではokにならない',t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'tema-rules-outside-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'.claude'));
 fs.writeFileSync(path.join(home,'.claude','CLAUDE.md'),`<!-- BEGIN: 絶対ルール (自動同期・編集しても上書きされる) -->\n絶対ルール本文\n<!-- END: 絶対ルール -->\n${Object.values(TEMA_RULE_HEADINGS).join('\n')}\n送信済みなのでカードは押さないで\n`);
 const step=absoluteTemaStep(home);
 assert.equal(step.status,'fail');
 assert.equal(step.reason,'tema=no; signin=no; consistency=no; card=no');
});
test('4状態×4列、fleet-statusにも同じ結果',()=>{
 const pcMap={'001':{},'002':{},'003':{},'004':{},_note:'除外'};
 const beacons=[{label:'001',reportedAt:new Date(now).toISOString(),steps:[{id:'absolute-rules-tema',status:'ok',reason:'tema=yes; signin=yes; consistency=yes; card=yes'}]}, {label:'002',reportedAt:new Date(now).toISOString(),steps:[{id:'absolute-rules-tema',status:'fail',reason:'tema=yes; signin=no; consistency=no'}]}, {label:'003',reportedAt:new Date(now).toISOString(),steps:[]}];
 const rows=buildTemaRollout({pcMap,beacons,now});assert.deepEqual(rows.map(r=>r.state),['反映済み','未反映','未報告（旧版のビーコン）','オフライン']);
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

test('GAS履歴を読み取り、順序に依存せず最新ビーコンとserverPollsで判定する', async t => {
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'rollout-history-'));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'.claude'));
 fs.writeFileSync(path.join(home,'.claude','fleet-sheet.env'),'FLEET_SHEET_URL=https://fixture.invalid\nFLEET_SHEET_TOKEN=fixture\n');
 const fixture=JSON.parse(fs.readFileSync(new URL('./fixtures/tema-beacon-history.json',import.meta.url),'utf8'));
 const pcMap={'008XPS8300':{},'old-active':{},'old-offline':{}};
 for(const beacons of [fixture.beacons,[...fixture.beacons].reverse()]) {
  let output,requests=0;
  assert.equal(await main(['--json'],{home,now,pcMap,stdout:s=>{output=JSON.parse(s);},fetchImpl:async (_url,init)=>{
   requests++;assert.equal(JSON.parse(init.body).kind,'fleet-beacon-list');
   return Response.json({...fixture,beacons});
  }}),0);
  assert.equal(requests,1);
  assert.deepEqual(output.map(r=>r.state),['未反映','稼働中・ビーコン未更新','オフライン']);
  assert.equal(output[0].signin,false);
  assert.equal(output[0].beaconAt,'2026-11-27T02:00:00.000Z');
  assert.equal(output[1].pollAt,'2026-11-27T02:59:00.000Z');
  const table=formatTemaRollout(output);
  assert.match(table,/最終ビーコン \| 最終poll/);
  assert.match(table,/2026-11-11 09:00:00 JST/);
  assert.match(table,/2026-11-27 11:59:00 JST/);
 }
});

test('CLIは既定homeを渡し、取得失敗をオフラインの表として保存しない',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rollout-error-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const out=path.join(dir,'table.md');fs.writeFileSync(out,'previous readback');
 let error='';
 const code=await main(['--out',out],{pcMap:{pc:{}},fetchBeacons:async options=>{
  assert.equal(options.home,process.env.ORGIAST_HOME ?? os.homedir());
  return {ok:false,reason:'unconfigured',beacons:[]};
 },stdout:()=>assert.fail('取得失敗時は表を表示しない'),stderr:s=>{error=s;}});
 assert.equal(code,3);assert.match(error,/判定できません/);
 assert.equal(fs.readFileSync(out,'utf8'),'previous readback');
});

test('24時間境界・pollだけのPC・card欠落を区別する',()=>{
 const at=ms=>new Date(ms).toISOString();
 const step={id:'absolute-rules-tema',status:'ok',reason:'tema=yes; signin=yes; consistency=yes; card=no'};
 const row=(age,pollAge,steps=[step])=>buildTemaRollout({pcMap:{pc:{}},now,
  beacons:[{label:'pc',reportedAt:at(now-age),steps}],serverPolls:{pc:at(now-pollAge)}})[0];
 assert.equal(row(86400000,86400000).state,'未反映');
 assert.equal(row(86400001,86400000).state,'稼働中・ビーコン未更新');
 assert.equal(row(86400001,86400001).state,'オフライン');
 assert.equal(row(0,0,[]).state,'未報告（旧版のビーコン）');
 assert.equal(buildTemaRollout({pcMap:{pc:{}},now,serverPolls:{pc:at(now)}})[0].state,'稼働中・ビーコン未更新');
});
