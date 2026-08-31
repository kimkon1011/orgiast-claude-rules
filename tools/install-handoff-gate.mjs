import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const scriptFile=fileURLToPath(import.meta.url),repo=path.dirname(path.dirname(scriptFile));
const stamp=()=>new Date().toISOString().replace(/[-:]/g,'').replace('T','-').slice(0,15);
const hookCount=s=>Object.values(s.hooks||{}).reduce((n,groups)=>n+(Array.isArray(groups)?groups.reduce((m,g)=>m+(Array.isArray(g.hooks)?g.hooks.length:0),0):0),0);
const commands=(s,event)=>((s.hooks||{})[event]||[]).flatMap(g=>g.hooks||[]).map(h=>h.command||'');
function addHook(settings,event,command){settings.hooks??={};settings.hooks[event]??=[];let group=settings.hooks[event].find(g=>g.matcher==='*')||settings.hooks[event][0];if(!group){group={matcher:'*',hooks:[]};settings.hooks[event].push(group);}group.hooks??=[];if(commands(settings,event).includes(command))return 0;group.hooks.push({type:'command',command});return 1;}
export function install({home=os.homedir(),apply=false,failReadBack=false,log=console.log}={}){
  const claude=path.join(home,'.claude'),settingsFile=path.join(claude,'settings.json');
  let raw;try{raw=fs.readFileSync(settingsFile,'utf8');}catch(e){throw new Error(`settings.json を読めません: ${e.message}`);}let settings;try{settings=JSON.parse(raw);}catch(e){throw new Error(`settings.json が不正JSONです: ${e.message}`);}
  const beforeCount=hookCount(settings),next=structuredClone(settings);
  let removed=0;for(const group of next.hooks?.Stop||[]){const hooks=group.hooks||[];group.hooks=hooks.filter(h=>{const old=String(h.command||'').includes('manual-handoff-detector.ps1');if(old)removed++;return !old;});}
  const gate=`node "${path.join(repo,'tools','handoff-quality-gate.mjs')}"`,report=`node "${path.join(repo,'tools','rule-compliance-report.mjs')}"`;
  const added=addHook(next,'Stop',gate)+addHook(next,'SessionStart',report),expected=beforeCount-removed+added;
  const oldHook=path.join(claude,'hooks','manual-handoff-detector.ps1'),renamed=`${oldHook}.bak-20260828-superseded`,renamePlanned=fs.existsSync(oldHook)&&!fs.existsSync(renamed);
  const settingsChanged=removed>0||added>0;
  log(`[${apply?'apply':'dry-run'}] Stop旧hook削除: ${removed}件 / 新hook追加: ${added}件 / hook総数: ${beforeCount} → ${expected}`);log(`[${apply?'apply':'dry-run'}] 旧hookリネーム: ${renamePlanned?path.basename(renamed):'変更なし'}`);
  if(!apply){log('[dry-run] 変更は書き込んでいません');return{changed:settingsChanged||renamePlanned};}
  if(!settingsChanged&&!renamePlanned){log('変更なし');return{changed:false};}
  let backup;
  try{
    if(settingsChanged){backup=`${settingsFile}.bak-${stamp()}`;fs.copyFileSync(settingsFile,backup);fs.writeFileSync(settingsFile,JSON.stringify(next,null,2)+'\n');const check=JSON.parse(fs.readFileSync(settingsFile,'utf8'));if(failReadBack||commands(check,'Stop').some(x=>x.includes('manual-handoff-detector.ps1'))||!commands(check,'Stop').includes(gate)||!commands(check,'SessionStart').includes(report)||hookCount(check)!==expected)throw new Error('read-back検査に失敗');}
    if(renamePlanned)fs.renameSync(oldHook,renamed);else if(fs.existsSync(oldHook)&&fs.existsSync(renamed))log('旧hookのリネーム先が存在するため上書きせずスキップ');
  }catch(e){if(backup)fs.copyFileSync(backup,settingsFile);throw new Error(`${e.message}; settings.json をバックアップから復元しました`);}
  log('適用とread-back検査が完了しました');return{changed:true,backup};
}
function option(name){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:undefined;}
if(isEntry(import.meta.url)){try{install({home:option('--home')||process.env.ORGIAST_HOME||os.homedir(),apply:process.argv.includes('--apply')});}catch(e){console.error(e.message);process.exitCode=1;}}
