import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeAudit, buildMailBody, ITEMS } from './security-audit-readonly.mjs';
import { buildMatrix, parseAuditMail } from './security-audit-report.mjs';
const good = () => ({ schemaVersion:1, host:'kim-PC', at:'2026-10-29T12:00:00Z', smb1Enabled:false, rdpEnabled:false, rdpNla:1, winrmListeners:0, sshdStatus:'Stopped', firewall:[{enabled:true}], inboundAllowAnyPublic:[], defender:{realtime:true,sigDate:'2026-10-28T12:00:00Z'}, systemDrive:'D:',bitlocker:[{mount:'D:',protection:'On'}],lastHotfixDate:'2026-10-20T12:00:00Z',tailscale:{installed:false},secrets:{hardcodedCredFiles:[],claudeKeyTxtCount:0,envFileCount:0},listenAllTcp:[],stuckJobs:{oldestNodeHours:0,cpuLoadPercent:5} });
test('正常値は全項目緑',()=>assert.equal(summarizeAudit(good()).green.length,ITEMS.length));
for (const [name, patch, item, level] of [
 ['SMB1', {smb1Enabled:true},'SMBv1','red'],
 ['RDP NLAなし',{rdpEnabled:true,rdpNla:0},'RDP','red'],
 ['RDP NLAあり',{rdpEnabled:true},'RDP','yellow'],
 ['SSH',{sshdStatus:'Running'},'sshd','red'],
 ['FW',{firewall:[{enabled:false}]},'FW無効','red'],
 ['Defender',{defender:{realtime:false,sigDate:'2026-10-28'}},'Defender','red'],
 ['暗号化',{bitlocker:[{mount:'D:',protection:'Off'}]},'BitLocker','red'],
 ['平文',{secrets:{hardcodedCredFiles:['a.js:1'],claudeKeyTxtCount:0,envFileCount:0}},'平文鍵','red'],
 ['鍵txt',{secrets:{hardcodedCredFiles:[],claudeKeyTxtCount:1,envFileCount:0}},'平文鍵','yellow'],
 ['env',{secrets:{hardcodedCredFiles:[],claudeKeyTxtCount:0,envFileCount:21}},'.env件数','yellow'],
 ['WinRM',{winrmListeners:1},'WinRM','yellow'],
 ['開発ポート',{listenAllTcp:[{port:3000,address:'0.0.0.0'}]},'0.0.0.0待受','yellow'],
 ['FW件数',{inboundAllowAnyPublic:Array(26).fill({})},'FW無効','yellow'],
 ['定義古い',{defender:{realtime:true,sigDate:'2026-10-25'}},'Defender','yellow'],
 ['更新古い',{lastHotfixDate:'2026-09-01'},'Update','yellow'],
 ['長寿命node',{stuckJobs:{oldestNodeHours:25,cpuLoadPercent:0}},'無人ジョブ詰まり','yellow'],
 ['高負荷',{stuckJobs:{oldestNodeHours:0,cpuLoadPercent:90}},'無人ジョブ詰まり','yellow'],
 ['Funnel',{tailscale:{installed:true,funnelStatus:'Funnel on http://127.0.0.1:3000'},listenAllTcp:[{port:3000,address:'0.0.0.0'}]},'Tailscale Funnel','red'],
]) test(name,()=>assert.ok(summarizeAudit({...good(),...patch})[level].some(r=>r.item===item)));
test('Funnelの別ポート・IPv6だけでは赤にしない',()=>{
 for(const p of [{port:3001,address:'0.0.0.0'},{port:3000,address:'::'}]) assert.equal(summarizeAudit({...good(), tailscale:{installed:true,funnelStatus:'Funnel on localhost:3000'},listenAllTcp:[p]}).red.length,0);
});
test('未取得は正常と偽らない',()=>{const s=summarizeAudit({});assert.equal(s.green.length,0);assert.equal(s.yellow.length,ITEMS.length);});
test('しきい値ちょうどは緑',()=>{
 const a=good();a.defender.sigDate='2026-10-26T12:00:00Z';a.lastHotfixDate='2026-09-14T12:00:00Z';a.secrets.envFileCount=20;a.inboundAllowAnyPublic=Array(25).fill({});a.stuckJobs.oldestNodeHours=24;
 assert.equal(summarizeAudit(a).green.length,ITEMS.length);
});
test('未回収と最新の採用は入力順によらない',()=>{
 const old={...good(),at:'2026-10-28T00:00:00Z',smb1Enabled:true};
 for(const results of [[old,good()],[good(),old]]) {const m=buildMatrix(results,['kim-PC','nishi-PC']);assert.deepEqual(m.missing,['nishi-PC']);assert.equal(m.rows[0].cells['kim-PC'].level,'green');assert.equal(m.rows[0].cells['nishi-PC'].level,'missing');}
});
test('60KBを超える日本語の本文を有効JSONのまま縮約',()=>{
 const a=good();a.secrets.hardcodedCredFiles=Array(3000).fill('日本語ファイル.js:42');a.secrets.envFileDirs=Array(1000).fill('ディレクトリ');a.inboundAllowAnyPublic=Array(1000).fill({name:'rule'});
 const body=buildMailBody(a,'kim-PC','20261029');assert.ok(Buffer.byteLength(body)<=60*1024);assert.ok(body.length<=20000);
 const record=parseAuditMail(body,'20261029');assert.equal(record.audit.truncated,true);assert.ok(record.audit.secrets.hardcodedCredFiles.length<=30);assert.equal(buildMatrix([record]).rows.find(r=>r.item==='平文鍵').cells['kim-PC'].level,'red');
});
test('他の巨大配列でもtransport制限を守り縮約前判定を維持',()=>{
 const a=good();a.listenAllTcp=Array(6000).fill({port:3000,address:'0.0.0.0',proc:'node'});
 const body=buildMailBody(a,'kim-PC','20261029');assert.ok(body.length<20000);assert.equal(parseAuditMail(body,'20261029').audit.summary.yellow.some(r=>r.item==='0.0.0.0待受'),true);
});
test('通常メールの往復・日付フィルター・detail上限',()=>{
 const a=good();const body=buildMailBody(a,'kim-PC','20261029');assert.deepEqual(parseAuditMail(body,'20261029').audit,a);assert.equal(parseAuditMail(body,'20261028'),null);
 a.sshdStatus='x'.repeat(300);for(const entries of Object.values(summarizeAudit(a)).filter(Array.isArray))for(const e of entries)assert.ok(e.detail.length<=120);
});

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claimAuditSend } from './security-audit-readonly.mjs';
test('送信マーカー・進行中ロック・24時間超過ロックの自己回復', () => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'audit-marker-'));
 const sent=path.join(dir,'kim-PC.sent-20261029');
 const pending=`${sent}.pending`;
 try {
  assert.equal(claimAuditSend(sent),true);
  assert.equal(claimAuditSend(sent),false);
  const before=fs.readFileSync(pending,'utf8');
  const mtime=fs.statSync(pending).mtimeMs;
  assert.equal(claimAuditSend(sent,mtime+86400000),false);
  assert.equal(fs.readFileSync(pending,'utf8'),before);
  assert.equal(claimAuditSend(sent,mtime+86400001),true);
  fs.renameSync(pending,sent);
  assert.equal(claimAuditSend(sent,mtime+172800000),false);
  assert.equal(fs.existsSync(pending),false);
 } finally { fs.rmSync(dir,{recursive:true,force:true}); }
});
test('打切り・読み取り失敗を正常としない', () => {
 for(const flag of ['scanTruncated','scanIncomplete']) {
  const a=good(); a.secrets[flag]=true;
  assert.ok(summarizeAudit(a).yellow.some(r=>r.item==='平文鍵'));
 }
});
