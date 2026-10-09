import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseArgs, renderReport, notificationText, validateSnapshot, validatePatterns } from './internal-audit.mjs';
import { runPaymentRules } from './lib/internal-audit/rules-payments.mjs';
import { adminScopeMessage } from './lib/internal-audit/exfil.mjs';
const sample=JSON.parse(await fs.readFile(new URL('./fixtures/internal-audit/snapshot.sample.json',import.meta.url)));
const patterns=JSON.parse(await fs.readFile(new URL('./internal-audit-patterns.json',import.meta.url)));
const root=fileURLToPath(new URL('../',import.meta.url));
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
 const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);const report=await fs.readFile(out,'utf8');for(const rule of ['R02','R05','R06','R08'])assert.match(report,new RegExp(`\\| ${rule} \\| [^0]`));if(process.platform!=='win32')assert.equal((await fs.stat(out)).mode&0o777,0o600);
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

test('stale lock allows main to finish and records recovery; fresh live PID rejects', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ia-lock-'));
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  const lock = path.join(dir, 'run.lock'), out = path.join(dir, 'report.md');
  const args = ['tools/internal-audit.mjs', '--snapshot', 'tools/fixtures/internal-audit/snapshot.sample.json', '--state-dir', dir, '--out', out, '--skip', 'gmail,drive,discord,admin,web,patterns'];
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
  assert.equal(spawnSync(process.execPath, args, { cwd: root }).status, 1);
  await fs.utimes(lock, new Date(0), new Date(0));
  const recovered = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(await fs.readFile(out, 'utf8'), /前回の中断を検出/);
  await assert.rejects(fs.stat(lock), { code: 'ENOENT' });
});
test('fresh dead PID lock self-heals and new lock records PID/start', async t => {
  const { acquireLock } = await import('./lib/internal-audit/lock.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ia-lock-'));
  t.after(() => fs.rm(dir, { force: true, recursive: true }));
  await fs.writeFile(path.join(dir, 'run.lock'), JSON.stringify({ pid: 999999 }));
  const lock = await acquireLock(dir, { alive: () => false });
  assert.equal(lock.recovered, true);
  const data = JSON.parse(await fs.readFile(path.join(dir, 'run.lock'), 'utf8'));
  assert.equal(data.pid, process.pid); assert.ok(data.startedAt);
  await lock.release();
});
test('severity tables never exceed 200 rows including overflow; baseline keeps top30 and others', () => {
  const snapshot = structuredClone(sample);
  snapshot.externalSharing = { building: true, summary: Array.from({ length: 35 }, (_, i) => ({ owner: 'kim@orgiast.jp', type: '外部ドメイン', domain: `d${i}.invalid`, count: 35 - i })) };
  const findings = ['high','medium','info'].flatMap(severity => Array.from({ length: 201 }, (_, i) => ({ rule: 'test', severity, subject: String(i), detail: 'detail', owner: 'kim@orgiast.jp', url: 'https://drive.google.com/file/d/test/view' })));
  const r = renderReport({ snapshot, findings, patterns, sources: {}, findingsFile: 'date.findings.jsonl' });
  for (const severity of ['high','medium','info']) {
    const table = r.split(`## ${severity}\n`)[1].split('\n## ')[0];
    assert.equal(table.split('\n').filter(s => s.startsWith('|')).length - 2, 200);
    assert.match(table, /他 2 件/);
  }
  assert.match(r, /他 5 ドメイン 15 件/);
  assert.match(r, /（\*\*kim@orgiast.jp\*\* で開く）/);
  assert.equal(parseArgs([])['drive-budget-seconds'], 600);
  for (const value of ['0', '-1', 'x', '1.5']) assert.throws(() => parseArgs(['--drive-budget-seconds', value]));
});
test('Drive report upload uses kim root folder, creates only when absent and reuses uploader', async () => {
  const { uploadReport } = await import('./lib/internal-audit/report-upload.mjs');
  for (const exists of [true, false]) {
    const calls = [];
    const result = await uploadReport('/local/report.md', {
      getToken: async args => { assert.equal(args.impersonate, 'kim@orgiast.jp'); return 'test'; },
      api: async (token, url, options) => { calls.push([String(url), options]); return { json: async () => options?.method === 'POST' ? { id: 'new-folder' } : { files: exists ? [{ id: 'existing' }] : [] } }; },
      uploadFile: async args => { assert.equal(args.as, 'kim@orgiast.jp'); assert.equal(args.folder, exists ? 'existing' : 'new-folder'); return { url: 'https://drive.google.com/file/d/report/view' }; },
    });
    assert.equal(calls.length, exists ? 1 : 2);
    assert.match(new URL(calls[0][0]).searchParams.get('q'), /'root' in parents/);
    assert.match(notificationText([], result.url, '2026-10-09'), /\[内部監査レポート 2026-10-09\]\(https:.*\)（\*\*kim@orgiast.jp\*\* で開く）/);
  }
});

test('upload failure or malformed response still provides local location for DM without secret logging', async () => {
  const { reportLocation } = await import('./lib/internal-audit/report-notify.mjs');
  const logs = [];
  for (const upload of [async () => { throw Error('secret'); }, async () => ({})]) {
    assert.equal(await reportLocation('/local/report.md', { upload, log: s => logs.push(s) }), '/local/report.md');
  }
  assert.ok(logs.every(s => s.includes('アップロード失敗') && !s.includes('secret')));
});
test('JSONL output collision fails before any data collection', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ia-path-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const date = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
  const r = spawnSync(process.execPath, ['tools/internal-audit.mjs', '--state-dir', dir, '--out', path.join(dir, 'reports', `${date}.findings.jsonl`)], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /衝突/);
});

test('overflow writes every finding as private JSONL, independently of report limit', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ia-overflow-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const snapshot = structuredClone(sample);
  snapshot.externalSharing = { building: false, summary: [] };
  snapshot.exfilFindings = Array.from({ length: 205 }, (_, i) => ({ rule: 'overflow', severity: 'high', subject: `s${i}`, detail: 'detail' }));
  const file = path.join(dir, 'input.json'), out = path.join(dir, 'report.md');
  await fs.writeFile(file, JSON.stringify(snapshot));
  const r = spawnSync(process.execPath, ['tools/internal-audit.mjs', '--snapshot', file, '--state-dir', dir, '--skip', 'gmail,drive,discord,admin,web,patterns', '--out', out], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const name = (await fs.readdir(path.join(dir, 'reports'))).find(f => f.endsWith('.jsonl'));
  const jsonl = path.join(dir, 'reports', name);
  assert.equal((await fs.readFile(jsonl, 'utf8')).trim().split('\n').map(JSON.parse).filter(f => f.rule === 'overflow').length, 205);
  // NTFS has no POSIX mode bits; the 0o600 guarantee is verified on POSIX runners only.
  if (process.platform !== 'win32') assert.equal((await fs.stat(jsonl)).mode & 0o777, 0o600);
});
