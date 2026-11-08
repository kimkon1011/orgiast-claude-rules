import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sessionLaneHealth, launchLaneAutoProbes } from './sessionstart-lane-health.mjs';
test('SessionStart returns lane summary and saves offline health',t=>{const home=fs.mkdtempSync(path.join(os.tmpdir(),'session-lane-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));const r=sessionLaneHealth({home, auditLaunch: () => false});assert.equal(r.hookSpecificOutput.hookEventName,'SessionStart');assert.match(r.hookSpecificOutput.additionalContext,/生存:.*停止:.*修復:/);assert.ok(fs.existsSync(path.join(home,'.claude/lane-health.json')));});

test('--hook preserves synchronous SessionStart context output', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lane-hook-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude/.unattended-audit-guard'), String(Date.now()));
  const script = fileURLToPath(new URL('./sessionstart-lane-health.mjs', import.meta.url));
  const outputs = [[], ['--hook']].map(args => {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', input: '{}', env: { ...process.env, ORGIAST_HOME: home },
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(output.hookSpecificOutput.additionalContext, /生存:.*停止:.*修復:/);
    assert.ok(fs.existsSync(path.join(home, '.claude/lane-health.json')));
    return output;
  });
  assert.deepEqual(outputs[1], outputs[0]);
});

test('SessionStart launches guarded audit and injects at most three previous lines', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-context-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude/unattended-job-audit-last.txt'), 'one\ntwo\nthree\nfour');
  let called;
  const result = sessionLaneHealth({ home, auditLaunch: options => { called = options; } });
  assert.equal(called.intervalHours, 6);
  assert.match(result.hookSpecificOutput.additionalContext, /\[無人ジョブ監査\] one \/ two \/ three/);
  assert.doesNotMatch(result.hookSpecificOutput.additionalContext, /four/);
});

test('SessionStart auto-probes only eligible lanes and throttles each provider for 30 minutes', t => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'lane-auto-probe-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
  const now=Date.parse('2026-10-26T03:00:00Z'), calls=[];
  const spawnProbe=(cmd,args,options)=>{calls.push({cmd,args,options});return {unref(){}};};
  const health={lanes:{codex:{alive:false,reason:'probe_failed:stale'},deepseek:{alive:false,reason:'dead:payment_required',probedAt:new Date(now-25*3600000).toISOString()},glm:{alive:false,reason:'cooldown',until:now+3600000},openrouter:{alive:true,reason:'probe_ok'},gemini:{alive:false,reason:'dead:payment_required',probedAt:new Date(now-3600000).toISOString()}}};
  assert.deepEqual(launchLaneAutoProbes(health,{home,now,spawnProbe}),['codex','deepseek']);
  assert.equal(calls.length,2); assert.ok(calls.every(c=>c.options.detached&&c.options.windowsHide&&c.options.stdio==='ignore'));
  assert.deepEqual(launchLaneAutoProbes(health,{home,now:now+29*60000,spawnProbe}),[]);
  health.lanes.codex.autoProbeStarted=false; health.lanes.deepseek.autoProbeStarted=false;
  assert.deepEqual(launchLaneAutoProbes(health,{home,now:now+30*60000,spawnProbe}),['codex','deepseek']);
});
