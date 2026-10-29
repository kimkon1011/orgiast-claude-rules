#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

export function taskCommand({node=process.execPath,script=fileURLToPath(new URL('./lahaina-kpi-daily.mjs',import.meta.url)),home=os.homedir()}={}) {
  const dir=path.join(home,'.claude','lahaina-kpi'); const log=path.join(dir,'run.log');
  const ps=`& '${node.replaceAll("'","''")}' '${script.replaceAll("'","''")}' *>> '${log.replaceAll("'","''")}'`;
  return {dir,log,task:`powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -Command "${ps}"`};
}
export function register() {
  if(process.platform!=='win32') throw new Error('Windows only');
  const c=taskCommand(); fs.mkdirSync(c.dir,{recursive:true});
  const args=['/create','/f','/tn','ClaudeLahainaKpiDaily','/sc','daily','/st','07:10','/tr',c.task];
  const made=spawnSync('schtasks.exe',args,{encoding:'utf8',windowsHide:true});
  if(made.status!==0) throw new Error(`schtasks create failed: ${made.stderr||made.stdout}`);
  const query=spawnSync('schtasks.exe',['/query','/tn','ClaudeLahainaKpiDaily','/fo','list','/v'],{encoding:'utf8',windowsHide:true});
  if(query.status!==0) throw new Error(`schtasks query failed: ${query.stderr||query.stdout}`);
  return {create:made.stdout.trim(),query:query.stdout.trim(),command:c.task};
}
if(isEntry(import.meta.url)) { try { console.log(JSON.stringify(register(),null,2)); } catch(e) { console.error(e.message); process.exitCode=1; } }
