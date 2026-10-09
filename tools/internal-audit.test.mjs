import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseArgs, renderReport, notificationText, validateSnapshot, validatePatterns } from './internal-audit.mjs';
import { runPaymentRules } from './lib/internal-audit/rules-payments.mjs';
import { adminScopeMessage } from './lib/internal-audit/exfil.mjs';
const sample=JSON.parse(await fs.readFile(new URL('./fixtures/internal-audit/snapshot.sample.json',import.meta.url)));
const patterns=JSON.parse(await fs.readFile(new URL('./internal-audit-patterns.json',import.meta.url)));
const root=new URL('../',import.meta.url).pathname;
test('strict options defaults duplicates values and combinations',()=>{
 assert.equal(parseArgs([])['window-days'],180);
 for(const args of [['--notify','--notify'],['--foo'],['--out'],['--window-days','0'],['--window-days','1.5'],['--skip','freee'],['--skip','gmail,gmail'],['--min-severity','bad'],['--snapshot','a','--json','b'],['--snapshot','a','--window-days','90']])assert.throws(()=>parseArgs(args));
});
test('redaction, safe Markdown, unavailable admin output, min severity',()=>{
 const s=structuredClone(sample);s.partners[0].name='<bad|name>';const secret='a-secret-value';const r=runPaymentRules(s,s.footprint,patterns);
 r.findings.push({rule:'test',severity:'high',subject:'test',detail:`${secret} postgres://user:pass@host/db Bearer token`});
 const report=renderReport({snapshot:s,...r,sources:{admin:{status:'unverified',reason:adminScopeMessage('test-client')}},patterns,secrets:[secret],minSeverity:'high'});
 assert.ok(report.includes('断定'));assert.ok(report.includes('DWD スコープ未付与'));assert.ok(report.includes('test-client'));assert.ok(!report.includes(secret));assert.ok(!report.includes('postgres://'));assert.ok(!report.includes('Bearer '));assert.ok(!report.includes('## medium'));assert.ok(report.includes('&lt;bad&#124;name&gt;'));
});
test('snapshot validation rejects wrong structure',()=>{assert.throws(()=>validateSnapshot({}));assert.equal(validateSnapshot(sample).version,1);});
test('offline CLI fixture replay, R02/R05/R06/R08, fail-on-high and private files',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ia-cli-'));t.after(()=>fs.rm(dir,{force:true,recursive:true}));const out=path.join(dir,'out.md');const args=['tools/internal-audit.mjs','--snapshot','tools/fixtures/internal-audit/snapshot.sample.json','--skip','gmail,drive,discord,admin,web,patterns','--state-dir',dir,'--out',out];
 const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);const report=await fs.readFile(out,'utf8');for(const rule of ['R02','R05','R06','R08'])assert.match(report,new RegExp(`\\| ${rule} \\| [^0]`));assert.equal((await fs.stat(out)).mode&0o777,0o600);
 const second=spawnSync(process.execPath,[...args,'--fail-on-high'],{cwd:root,encoding:'utf8'});assert.equal(second.status,2,second.stderr);assert.deepEqual(JSON.parse(await fs.readFile(path.join(dir,'state.json'),'utf8')),{});
});
test('cannot overwrite input/env/state and held lock fails',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ia-cli-'));t.after(()=>fs.rm(dir,{force:true,recursive:true}));const base=['tools/internal-audit.mjs','--snapshot','tools/fixtures/internal-audit/snapshot.sample.json','--skip','gmail,drive,discord,admin,web,patterns','--state-dir',dir];
 for(const out of ['tools/fixtures/internal-audit/snapshot.sample.json','.env.local',path.join(dir,'state.json')])assert.equal(spawnSync(process.execPath,[...base,'--out',out],{cwd:root}).status,1);
 await fs.writeFile(path.join(dir,'run.lock'),'');assert.equal(spawnSync(process.execPath,base,{cwd:root}).status,1);
});
test('notification stays under DM limit for five high findings and includes path',()=>{
 const findings=Array.from({length:10},()=>({severity:'high',rule:'R08',subject:'x'.repeat(300),detail:'y'.repeat(300)}));const text=notificationText(findings,'/local/report.md','2026-10-09');assert.ok(text.length<2000);assert.ok(text.endsWith('/local/report.md'));assert.equal(text.split('\n').filter(s=>s.startsWith('-')).length,5);
});
test('JSON output cannot replace the mandatory daily report',async t=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'ia-cli-'));t.after(()=>fs.rm(dir,{force:true,recursive:true}));const date=new Date(Date.now()+9*3600000).toISOString().slice(0,10);
 const r=spawnSync(process.execPath,['tools/internal-audit.mjs','--state-dir',dir,'--json',path.join(dir,'reports',date+'.md'),'--skip','gmail,drive,discord,admin,web,patterns'],{cwd:root,encoding:'utf8'});assert.equal(r.status,1);assert.ok(r.stderr.includes('日次レポート'));
});

test('invalid configured thresholds fail closed',()=>{
 assert.equal(validatePatterns(patterns),patterns);
 for(const custom of [{...patterns,thresholds:{}},{...patterns,thresholds:{...patterns.thresholds,approval:[100,50]}},{...patterns,thresholds:{...patterns.thresholds,approval_lower_ratio:1}}])assert.throws(()=>validatePatterns(custom));
});
