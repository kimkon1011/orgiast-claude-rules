import fs from 'node:fs';
import path from 'node:path';

export const TEMA_RULE_HEADINGS = Object.freeze({tema:'▶ 手間チェック',signin:'▶ ブラウザのサインイン委任',consistency:'▶ 送信前の整合性チェック'});
export function absoluteTemaStep(home) {
  let block='';
  try {
    const text=fs.readFileSync(path.join(home,'.claude','CLAUDE.md'),'utf8');
    block=text.match(/<!-- BEGIN: 絶対ルール[^>]*-->([\s\S]*?)<!-- END: 絶対ルール -->/)?.[1] || '';
  }catch { /* 未設置・読取失敗も欠落として報告する。 */ }
  const values=Object.entries(TEMA_RULE_HEADINGS).map(([key,heading])=>[key,block.includes(heading)]);
  values.push(['card', block.includes('送信済みなのでカードは押さないで')]);
  return {id:'absolute-rules-tema',status:values.every(([,v])=>v)?'ok':'fail',reason:values.map(([k,v])=>`${k}=${v?'yes':'no'}`).join('; ')};
}
export function temaRulesFromBeacon(beacon,now=Date.now(),pollAt=null) {
  const step=beacon?.steps?.find(s=>s.id==='absolute-rules-tema');
  const result=Object.fromEntries([...Object.keys(TEMA_RULE_HEADINGS), 'card'].map(k=>[k,step ? new RegExp(`(?:^|;\\s*)${k}=yes(?:;|$)`).test(step.reason || '') : null]));
  const age=now-Date.parse(beacon?.reportedAt);
  const beaconFresh = Number.isFinite(age) && age >= 0 && age <= 86400000;
  const pollAge = pollAt === null ? NaN : now - pollAt;
  const pollFresh = Number.isFinite(pollAge) && pollAge >= 0 && pollAge <= 86400000;
  result.state = !beaconFresh
    ? pollFresh ? '稼働中・ビーコン未更新' : 'オフライン'
    : !step ? '未報告（旧版のビーコン）' : Object.values(result).every(Boolean) ? '反映済み' : '未反映';
  return result;
}
