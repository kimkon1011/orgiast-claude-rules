#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
export const TASK_NAME = 'EIG-KPI-Watch';
export function register({ spawn=spawnSync, node=process.execPath }={}) {
  const script=fileURLToPath(new URL('./eig-kpi-watch.mjs', import.meta.url));
  const command=`\"${node}\" \"${script}\"`;
  const made=spawn('schtasks.exe',['/Create','/F','/TN',TASK_NAME,'/SC','DAILY','/ST','08:30','/DU','09:00','/RI','540','/ED','2026/12/12','/TR',command],{encoding:'buffer',windowsHide:true});
  if(made.status!==0) throw new Error(`schtasks create failed (${made.status})`);
  const query=spawn('schtasks.exe',['/Query','/TN',TASK_NAME,'/V','/FO','LIST'],{encoding:'buffer',windowsHide:true});
  if(query.status!==0) throw new Error(`schtasks query failed (${query.status})`);
  return { command, query:query.stdout.toString('utf8') };
}
if(isEntry(import.meta.url)){try{console.log(JSON.stringify(register(),null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
