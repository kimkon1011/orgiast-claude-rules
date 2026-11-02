#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveRegisterToolsDir } from './resolve-synced-repo.mjs';
const home=os.homedir();
if(!fs.existsSync(path.join(home,'.claude','line-history-sync.json'))) throw Error('Trusted LINE source configuration missing');
const fallbackTools=path.dirname(fileURLToPath(import.meta.url));
const tools=resolveRegisterToolsDir({fallback:fallbackTools,requiredLeaves:['line-history-sync.mjs','lib/drive-auth.mjs','lib/gws-proxy.mjs']});
const q=s=>`'${s.replaceAll("'","''")}'`;
const script=path.join(tools,'line-history-sync.mjs'), hidden=path.join(home,'.claude','tools','run-hidden.vbs');
if(!fs.existsSync(hidden)) throw Error('run-hidden.vbs missing');
const args=`"${hidden}" "${process.execPath}" "${script}"`;
const command=`$ErrorActionPreference='Stop'\n$a=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32/wscript.exe') -Argument ${q(args)} -WorkingDirectory ${q(path.dirname(tools))}\n$t=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)\n$s=New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20)\n$p=New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited\nRegister-ScheduledTask -TaskName 'OrgiastLineHistorySync' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null`;
execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',command],{windowsHide:true,stdio:'pipe',timeout:60000});
console.log('OrgiastLineHistorySync registered (hourly, hidden)');
