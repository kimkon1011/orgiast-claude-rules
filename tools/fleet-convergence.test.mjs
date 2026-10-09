import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { DAY, collectConvergence, convergenceProblems, convergenceAddress, missingHooks } from './fleet-convergence.mjs';
import { reconcileConvergence, convergenceTargets } from './fleet-convergence-watch.mjs';
import { receiveConvergence, syncInvocation } from './fleet-convergence-sync.mjs';
import { bootstrapUser } from './session-bootstrap.mjs';
import { reportConvergence } from './fleet-convergence-report.mjs';
const repo = path.resolve('.');
const now = Date.parse('2026-10-09T12:00:00Z');
const healthy = () => ({ label: 'example-PC', hostname: '作業用011', username: 'alice', convergenceReportedAt: new Date(now).toISOString(), behindMain: 0, hookMissing: 0, keyMissing: 0 });
function home(t) { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-convergence-')); fs.mkdirSync(path.join(p, '.claude')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }

test('receipt contains no secrets, knows email, distinguishes users and preserves unknown git', t => {
  const h = home(t); fs.writeFileSync(path.join(h, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a@example.org', token: 'SECRET' } }));
  fs.writeFileSync(path.join(h, '.claude/keyserve.env'), 'ORGIAST_KEYSERVE_SECRET=SECRET\nORGIAST_KEYSERVE_PC=example-PC\n');
  const row = collectConvergence({ home: h, repo, hostname: 'host', username: 'alice', now: new Date(now), git: () => { throw Error(); }, expectedHooks: { hooks: {} } });
  assert.equal(row.claudeAccount, 'a@example.org'); assert.equal(row.behindMain, null); assert.equal(row.hookMissing, 0); assert.ok(row.keyMissing > 0);
  assert.ok(!JSON.stringify(row).includes('SECRET')); assert.notEqual(convergenceAddress(row), convergenceAddress({ ...row, username: 'bob' }));
});
test('commit count and oldest missing timestamp use actual HEAD..origin/main', t => {
  const calls = []; const row = collectConvergence({ home: home(t), repo, expectedHooks: { hooks: {} }, git: args => {
    calls.push(args.join(' ')); if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? 'a'.repeat(40) : 'b'.repeat(40);
    if (args[0] === 'rev-list') return '2'; return '2026-10-07T00:00:00Z\n2026-10-09T00:00:00Z';
  } });
  assert.equal(row.behindMain, 2); assert.equal(row.missingSince, '2026-10-07T00:00:00Z'); assert.ok(calls.includes('rev-list --count HEAD..origin/main'));
});
test('hook set checks event, matcher, path and async, preserves custom extras', () => {
  const h = { type: 'command', command: 'node /repo/tools/check.mjs' };
  const expected = { PreToolUse: [{ matcher: 'Bash', hooks: [h] }] };
  assert.equal(missingHooks({ Stop: [{ hooks: [h] }] }, expected).length, 1);
  assert.equal(missingHooks({ PreToolUse: [{ matcher: 'Edit', hooks: [h] }] }, expected).length, 1);
  assert.equal(missingHooks({ PreToolUse: [{ matcher: 'Bash', hooks: [{...h, command: 'node /stale/tools/check.mjs'}] }] }, expected).length, 1);
  assert.equal(missingHooks({...expected, Stop: [{hooks:[h]}]}, expected).length, 0);
});
test('expected registrar is read-only and matches real fresh per-user registrations', t => {
  const h = home(t), env = { ...process.env, ORGIAST_HOME: h, ORGIAST_REPO: repo };
  const expected = JSON.parse(execFileSync(process.execPath, ['tools/register-hooks.mjs', '--expected-json'], { env, encoding: 'utf8' }));
  assert.equal(fs.existsSync(path.join(h, '.claude/settings.json')), false);
  execFileSync(process.execPath, ['tools/register-hooks.mjs', '--hooks-only'], { env });
  const actual = JSON.parse(fs.readFileSync(path.join(h, '.claude/settings.json')));
  assert.deepEqual(missingHooks(actual.hooks, expected.hooks), []);
});
test('24h main lag and 48h silence are independent; blank counts never mean healthy', () => {
  assert.deepEqual(convergenceProblems(healthy(), now), []);
  assert.ok(!convergenceProblems({...healthy(), behindMain: 1, missingSince: new Date(now-DAY+1).toISOString()}, now).length);
  assert.ok(convergenceProblems({...healthy(), behindMain: 1, missingSince: new Date(now-DAY).toISOString()}, now).includes('main反映が24時間以上遅延'));
  assert.ok(convergenceProblems({...healthy(), convergenceReportedAt: new Date(now-2*DAY).toISOString()}, now).includes('48時間報告なし'));
  assert.ok(convergenceProblems({...healthy(), hookMissing: ''}, now).includes('収束状態未確認'));
});
test('send once daily, notify only after 24h, reset on recovery, no writes in dry-run', async () => {
  const rows = [{...healthy(), hookMissing: 2}], sends = [], notices = []; let writes = 0;
  const deps = { rows, send: async p => sends.push(p), notify: async s => { notices.push(s); return {delivered:'dm'}; }, persist: () => writes++ };
  let r = await reconcileConvergence({...deps, now}); assert.equal(sends.length,1); assert.equal(notices.length,0);
  r = await reconcileConvergence({...deps, state:r.state, now:now+1000}); assert.equal(sends.length,1);
  r = await reconcileConvergence({...deps, state:r.state, now:now+DAY}); assert.equal(sends.length,2); assert.equal(notices.length,1);
  await reconcileConvergence({...deps, state:r.state, now:now+DAY+1000}); assert.equal(notices.length,1);
  const w = writes; await reconcileConvergence({...deps, state:r.state, now:now+3*DAY, dryRun:true}); assert.equal(writes,w);
  r = await reconcileConvergence({...deps, rows:[healthy()], state:r.state, now}); assert.deepEqual(r.state.targets, {});
});
test('ambiguous send retries same ID and does not mark successful delivery', async () => {
  const ids = []; let state;
  const deps = { rows:[{...healthy(), keyMissing:2}], now, send: async p => {ids.push(p.id); throw Error('lost response');}, persist: s => {state=structuredClone(s);}, notify: async () => ({delivered:'none'}) };
  await reconcileConvergence(deps); assert.equal(Object.values(state.targets)[0].sentAt, undefined);
  await reconcileConvergence({...deps, state, now:now+1000}); assert.equal(ids[0],ids[1]);
});
test('receiver only executes validated fixed sync and survives lost reply without rerun', async t => {
  const h=home(t), identity=healthy(), address=convergenceAddress(identity); let runs=0, replies=0;
  const mail={id:'mail-test',from:'kim-PC',to:address,kind:'note',expiresAt:new Date(now+DAY).toISOString(),body:JSON.stringify({action:'rules-resync',version:1,hostname:identity.hostname,username:identity.username})};
  const request=async(kind,p)=>{ if(kind==='mail-poll') return {messages:[mail]}; if(++replies===1) throw Error('lost reply'); return {mail}; };
  const run=(exe,args)=>{runs++;assert.equal(exe,process.execPath);assert.deepEqual(args,[path.join(repo,'tools/onboarding-sync.mjs'),'--force']);return {status:0};};
  await assert.rejects(receiveConvergence({home:h,repo,identity,now,request,run}));
  await receiveConvergence({home:h,repo,identity,now:now+1000,request,run}); assert.equal(runs,1);
});
test('receiver rejects arbitrary actions, wrong users and untrusted sender', async t => {
  for(const override of [{from:'other-PC'},{body:'{"action":"run"}'},{to:'all'}]) {
    const h=home(t), identity=healthy(); let runs=0;
    const mail={id:'mail-test',from:'kim-PC',to:convergenceAddress(identity),kind:'note',expiresAt:new Date(now+DAY).toISOString(),body:JSON.stringify({action:'rules-resync',version:1,hostname:identity.hostname,username:identity.username}),...override};
    await receiveConvergence({home:h,repo,identity,now,request:async kind=>kind==='mail-poll'?{messages:[mail]}:{mail},run:()=>{runs++;}}); assert.equal(runs,0);
  }
});
for(const platform of ['darwin','linux','win32']) test(`${platform} first-user bootstrap and repair use Node, preserve user home`, () => {
  const calls=[];const result=bootstrapUser({home:'/fixture/user',repo,platform,run:(exe,args,options)=>{calls.push({exe,args,options});return{status:0};}});
  assert.equal(result.registered,true);assert.equal(calls.length,2);assert.equal(calls[0].options.env.ORGIAST_HOME,'/fixture/user');assert.equal(calls[0].exe,process.execPath);
  assert.equal(syncInvocation(repo,platform)[0],process.execPath); assert.ok(calls[1].args[0].endsWith('onboarding-sync.mjs'));
});
test('sheet rows separate same-host users and convergence writes preserve old metrics', () => {
  const c={}; vm.createContext(c);vm.runInContext(fs.readFileSync('gas/fleet-status-sheet/UpsertLogic.gs','utf8').replace(/\bconst\s+/g,'var '),c);
  const headers=Object.values(c.FLEET_HEADERS_), rows=[];
  const apply=p=>{const r=c.fleetPlanUpsert(headers,rows,p);rows[r.rowIndex] ||= Array(headers.length).fill('');for(const [k,v] of Object.entries(r.values)) rows[r.rowIndex][k]=v;return r;};
  const a={...healthy(),label:'example-PC',convergenceOnly:true,convergenceId:'one'};
  apply(a);apply({...a,username:'bob',convergenceId:'two'});assert.equal(rows.length,2);
  const cost=headers.indexOf(c.FLEET_HEADERS_.claudeUsd);rows[0][cost]=100;
  apply({...a,syncHead:'abc',hookMissing:0,keyMissing:null});assert.equal(rows[0][cost],100);assert.equal(rows.length,2);
  assert.equal(rows[0][headers.indexOf(c.FLEET_HEADERS_.keyMissing)],'未確認');
});
test('report rejects old GAS silent fallback rather than claiming receipt', async t => {
  const h=home(t); fs.writeFileSync(path.join(h,'.claude/fleet-sheet.env'),'FLEET_SHEET_URL=https://example.org\nFLEET_SHEET_TOKEN=SECRET');
  await assert.rejects(reportConvergence({home:h,repo,fetchImpl:async()=>({ok:true,json:async()=>({ok:true,row:2})})}),/receipt missing/);
});

test('auth unset enrollment retries daily, failed attempts do not hammer SessionStart', t => {
  const h=home(t);
  fs.writeFileSync(path.join(h,'.claude/enroll.env'),'ORGIAST_ENROLL_TOKEN=test-token\nORGIAST_KEYSERVE_PC=example-PC\n');
  const script=`let calls=0; globalThis.fetch=async()=>{calls++;return {ok:false,status:401,json:async()=>({})};};
    const {provisionKeys}=await import(${JSON.stringify(new URL('./onboarding-sync.mjs',import.meta.url).href)});
    const t=new Date('2026-10-09T12:00:00Z');
    await provisionKeys(t,{quiet:true}); await provisionKeys(new Date(+t+1000),{quiet:true});
    if(calls!==1)throw Error('retry was not suppressed');
    await provisionKeys(new Date(+t+86400000),{quiet:true});if(calls!==2)throw Error('daily retry missing');
    await provisionKeys(new Date(+t+86401000),{quiet:true,force:true});if(calls!==3)throw Error('force retry missing');`;
  execFileSync(process.execPath,['--input-type=module','-e',script],{env:{...process.env,ORGIAST_HOME:h,ORGIAST_KEYSERVE_SECRET:'',ORGIAST_KEYSERVE_PC:'example-PC'},stdio:'pipe'});
  assert.ok(fs.existsSync(path.join(h,'.claude/enroll.env')));
});

test('monitor hides matched manual aliases but keeps every reported OS user and unmatched PCs', () => {
  const roster={'example-PC':{sheetName:'手書PC',hostname:'作業用011'}};
  const rows=[{pcName:'手書PC'},healthy(),{...healthy(),username:'bob'},{pcName:'unknown'},{pcName:'unknown'},{}];
  assert.deepEqual(convergenceTargets(rows,roster).map(x=>x.username||x.pcName),['alice','bob','unknown']);
});

test('missing names include definition drift and unavailable tools without exposing command arguments', t => {
  const h = home(t);
  const hook = { type: 'command', command: 'node "/repo/tools/gate-hook-runner.mjs" "/repo/tools/check.mjs" --secret=VALUE' };
  const expectedHooks = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [hook] }] }, skippedNames: ['missing.mjs'] };
  fs.writeFileSync(path.join(h, '.claude/settings.json'), JSON.stringify({ hooks: expectedHooks.hooks }));
  let row = collectConvergence({ home: h, repo, expectedHooks });
  assert.deepEqual(row.hookMissingNames, ['unavailable:missing.mjs']);
  fs.writeFileSync(path.join(h, '.claude/settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Edit', hooks: [hook] }] } }));
  row = collectConvergence({ home: h, repo, expectedHooks });
  assert.deepEqual(row.hookMissingNames, ['PreToolUse:check.mjs', 'unavailable:missing.mjs']);
  assert.equal(row.hookMissing, 2);
  assert.equal(JSON.stringify(row).includes('VALUE'), false);
});
