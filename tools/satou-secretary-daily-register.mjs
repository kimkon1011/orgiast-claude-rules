#!/usr/bin/env node
// 朝の業務報告DMを 06:30 に送り、失敗時だけ 07:30 にもう1回自動実行する。
// 07:30 側は satou-secretary-daily.mjs が「送信済みの印（delivered-<日付>）」を
// 見て、送信済みなら何もせず終わる（データ収集・LLM呼び出しも発生しない）。
import{spawnSync}from'node:child_process';import fs from'node:fs';import os from'node:os';import path from'node:path';import{fileURLToPath}from'node:url';import{isEntry}from'./is-entry.mjs';
export const TASK_NAME='ClaudeSatouSecretaryDaily';
export const TASK_RETRY_NAME='ClaudeSatouSecretaryDailyRetry';
export const TASK_TIMES={[TASK_NAME]:'06:30',[TASK_RETRY_NAME]:'07:30'};
export function taskCommand({node=process.execPath,script=fileURLToPath(new URL('./satou-secretary-daily.mjs',import.meta.url)),home=os.homedir(),hiddenLauncher=path.join(home,'.claude','tools','run-hidden.vbs')}={}){
  const dir=path.join(home,'.claude','satou-secretary'),wrapper=path.join(home,'.claude','tools','satou-secretary-daily-wrapper.bat');
  return{dir,wrapper,script,
    // コンソール窓を出さないため、登録は既存の run-hidden.vbs 経由で行う（2026-10-26..29 の経験）。
    task:`wscript.exe //nologo "${hiddenLauncher}" "${wrapper}"`};}
export function register({spawn=spawnSync,node=process.execPath,home=os.homedir()}={}){
  const c=taskCommand({node,home});
  fs.mkdirSync(c.dir,{recursive:true});
  fs.mkdirSync(path.dirname(c.wrapper),{recursive:true});
  fs.writeFileSync(c.wrapper,`@echo off\r\n"${node}" "${c.script}" >> "${path.join(c.dir,'run.log')}" 2>&1\r\n`,'utf8');
  const out={command:c.task,wrapper:c.wrapper};
  for(const[name,time]of Object.entries(TASK_TIMES)){
    const x=spawn('schtasks.exe',['/create','/f','/tn',name,'/sc','daily','/st',time,'/tr',c.task],{encoding:'utf8',windowsHide:true});
    if(x.status!==0)throw Error(`${name} 登録失敗: ${x.error?.message||x.stderr||x.stdout}`);
    const q=spawn('schtasks.exe',['/query','/tn',name,'/fo','list','/v'],{encoding:'utf8',windowsHide:true});
    if(q.status!==0)throw Error(`${name} 登録確認失敗: ${q.error?.message||q.stderr||q.stdout}`);
    out[name]={time,create:x.stdout.trim(),query:q.stdout.trim()};
  }
  return out;}
if(isEntry(import.meta.url))try{console.log(JSON.stringify(register(),null,2));}catch(e){console.error(e.message);process.exitCode=1;}
