#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { fetchBeacons } from './fleet-beacon.mjs';
import { buildFleetStatus } from './fleet-status.mjs';
export function buildTemaRollout(options) {
  return buildFleetStatus(options).map(r=>({pc:r.label,...r.temaRules,beaconAt:r.beaconAt,pollAt:r.pollAt}));
}
export function formatTemaRollout(rows) {
  const cell=v=>v===null?'未報告':v?'○':'×';
  const time = value => value ? new Date(Date.parse(value) + 9 * 3600000).toISOString().replace('T', ' ').slice(0, 19) + ' JST' : '未報告';
  return ['| PC | 手間チェック | サインイン委任 | 整合性チェック | カード注意 | 状態 | 最終ビーコン | 最終poll |','|---|---|---|---|---|---|---|---|',...rows.map(r=>`| ${String(r.pc).replace(/\|/g,'\\|')} | ${cell(r.tema)} | ${cell(r.signin)} | ${cell(r.consistency)} | ${cell(r.card)} | ${r.state} | ${time(r.beaconAt)} | ${time(r.pollAt)} |`)].join('\n')+'\n';
}
export async function main(argv=process.argv.slice(2),deps={}) {
  const pcMap=deps.pcMap ?? JSON.parse(fs.readFileSync(fileURLToPath(new URL('../fleet-pc-map.json',import.meta.url)),'utf8'));
  const result=await (deps.fetchBeacons ?? fetchBeacons)({home:deps.home ?? process.env.ORGIAST_HOME ?? os.homedir(),fetchImpl:deps.fetchImpl});
  if (result.ok === false) {
    (deps.stderr ?? console.error)(`tema-rollout-check: ビーコン取得失敗（${result.reason || '不明'}）。PCの稼働状態は判定できません`);
    return 3;
  }
  const rows=buildTemaRollout({pcMap,beacons:result.beacons || [],serverPolls:result.serverPolls || {},now:deps.now ?? Date.now()});
  const output=argv.includes('--json')?JSON.stringify(rows,null,2)+'\n':formatTemaRollout(rows);
  const i=argv.indexOf('--out');if(i>=0){if(!argv[i+1] || argv[i+1].startsWith('--'))throw Error('--out の保存先が必要');fs.writeFileSync(argv[i+1],output,'utf8');}
  (deps.stdout ?? console.log)(output);
  return result.ok===false?3:0;
}
if(isEntry(import.meta.url))try{process.exitCode=await main();}catch(e){console.error(e.message);process.exitCode=3;}
