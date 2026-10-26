import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
function setup(lane='implement', model='claude-fable-5', extra={}) { const home=fs.mkdtempSync(path.join(os.tmpdir(),'lane-')); fs.mkdirSync(path.join(home,'.claude','session-lane'),{recursive:true}); fs.writeFileSync(path.join(home,'.claude','session-lane','s.json'),JSON.stringify({lane,toolCalls:extra.toolCalls||0,laneOk:extra.laneOk,at:extra.at||new Date().toISOString(),prompt:extra.prompt||'[LANE-OK]'})); fs.writeFileSync(path.join(home,'t.jsonl'),JSON.stringify({message:{model}})+'\n'); if(extra.config) fs.writeFileSync(path.join(home,'.claude','lane-guard.json'),JSON.stringify(extra.config)); return home; }
function run(home, overrides={}) { const input={session_id:'s',transcript_path:path.join(home,'t.jsonl'),tool_name:'Write',tool_input:{file_path:path.join(home,'x.js')},...overrides}; const r=spawnSync(process.execPath,['tools/pretooluse-lane-guard.mjs'],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,ORGIAST_HOME:home}}); return r.stdout.trim()?JSON.parse(r.stdout):null; }
test('カウントし warnAt 境界で警告',()=>{const h=setup('implement','claude-fable-5',{toolCalls:3}); assert.match(run(h).hookSpecificOutput.additionalContext,/4 回/);});
test('blockAt 境界でdeny',()=>{const h=setup('implement','claude-opus-5',{toolCalls:7}); assert.equal(run(h).hookSpecificOutput.permissionDecision,'deny');});
test('consultはblockしない',()=>{const h=setup('consult','claude-fable-5',{toolCalls:7}); assert.ok(!run(h).hookSpecificOutput.permissionDecision);});
test('LANE-OKはblockしない',()=>{const h=setup('bulk','claude-fable-5',{toolCalls:7,laneOk:true}); assert.ok(!run(h).hookSpecificOutput.permissionDecision);});
test('warn modeでもblockする',()=>{const h=setup('verify','claude-fable-5',{toolCalls:7,config:{mode:'warn'}}); assert.equal(run(h).hookSpecificOutput.permissionDecision,'deny');});
for(const model of ['claude-sonnet-5','claude-haiku-4']) test(model+'もdeny',()=>assert.equal(run(setup('implement',model,{toolCalls:7})).hookSpecificOutput.permissionDecision,'deny'));
test('subagentsは除外',()=>{const h=setup(); assert.equal(run(h,{transcript_path:path.join(h,'subagents','x.jsonl')}),null);});
test('委譲コマンドは除外',()=>{const h=setup(); assert.equal(run(h,{tool_name:'Bash',tool_input:{command:'node tools/codex-do.mjs --prompt-file x'}}),null);});
test('read-onlyは除外',()=>{const h=setup(); assert.equal(run(h,{tool_name:'Bash',tool_input:{command:'git status'}}),null);});
test('.md編集は除外',()=>{const h=setup(); assert.equal(run(h,{tool_input:{file_path:path.join(h,'x.md')}}),null);});
test('生存レーンありは旧bypass条件でもdeny',()=>{const h=setup('implement','claude-opus-5',{toolCalls:7});fs.writeFileSync(path.join(h,'.claude/provider-cooldown.json'),JSON.stringify({codex:{until:Date.now()+3600000,reason:'usage_limit_no_fallback'}}));fs.writeFileSync(path.join(h,'.claude/lane-health.json'),JSON.stringify({implementOrder:['deepseek']}));const r=run(h).hookSpecificOutput;assert.equal(r.permissionDecision,'deny');assert.match(r.permissionDecisionReason,/deepseek.*codex-do\.mjs/);});
test('全滅かつ新鮮なprobeでもdeny',()=>{const h=setup('implement','claude-opus-5',{toolCalls:7});fs.writeFileSync(path.join(h,'.claude/lane-health.json'),JSON.stringify({implementOrder:[],probedAt:new Date().toISOString()}));const r=run(h).hookSpecificOutput;assert.equal(r.permissionDecision,'deny');assert.match(r.permissionDecisionReason,/全滅なら実装を止め/);});
test('全滅かつ古いprobeはdeny',()=>{const h=setup('implement','claude-opus-5',{toolCalls:7});fs.writeFileSync(path.join(h,'.claude/lane-health.json'),JSON.stringify({implementOrder:[],probedAt:new Date(Date.now()-3600000).toISOString()}));const r=run(h).hookSpecificOutput;assert.equal(r.permissionDecision,'deny');assert.match(r.permissionDecisionReason,/lane-doctor\.mjs --probe/);});
test('lane-doctor呼び出しは委譲扱い',()=>{const h=setup('implement','claude-opus-5',{toolCalls:100});assert.equal(run(h,{tool_name:'Bash',tool_input:{command:'node tools/lane-doctor.mjs --probe'}}),null);});
test('autopilot-tick呼び出しは委譲扱い',()=>{const h=setup('implement','claude-opus-5',{toolCalls:100});assert.equal(run(h,{tool_name:'Bash',tool_input:{command:'node tools/autopilot-tick.mjs post --status running'}}),null);});

test('Codex alive deny points directly to codex-do without unavailable wording',t=>{
  const h=setup('implement','claude-opus-5',{toolCalls:7});
  t.after(()=>fs.rmSync(h,{recursive:true,force:true}));
  fs.writeFileSync(path.join(h,'.claude/lane-health.json'),JSON.stringify({implementOrder:['codex','deepseek']}));
  const r=run(h).hookSpecificOutput;
  assert.equal(r.permissionDecision,'deny');
  assert.match(r.permissionDecisionReason,/Codex は生きている。node tools\/codex-do\.mjs --prompt-file <指示> --cwd <対象> へ渡せ/);
  assert.doesNotMatch(r.permissionDecisionReason,/使えない時/);
});

test('userFacing consultは5回呼んでも警告しない、過去ログは数えない', t => {
  const h = setup('consult'); t.after(() => fs.rmSync(h, { recursive: true, force: true }));
  const file = path.join(h, '.claude', 'session-lane', 's.json'); fs.writeFileSync(file, JSON.stringify({ lane: 'consult', userFacing: true, toolCalls: 0 }));
  for (let i = 0; i < 5; i++) assert.equal(run(h), null);
  assert.equal(run(h, { tool_name: 'Grep', tool_input: { path: '~/.claude/projects', pattern: 'MacroDroid' } }), null);
  assert.equal(JSON.parse(fs.readFileSync(file)).toolCalls, 5);
});
test('override file no longer bypasses; session approval does', t => {
  const h = setup('implement','claude-sonnet-5',{toolCalls:7}); t.after(()=>fs.rmSync(h,{recursive:true,force:true}));
  fs.writeFileSync(path.join(h,'.claude/cost-enforce-override'),'1');
  assert.equal(run(h).hookSpecificOutput.permissionDecision,'deny');
  fs.writeFileSync(path.join(h,'.claude/claude-impl-allow.json'),JSON.stringify({sessionId:'s',marker:'[CLAUDE-IMPL-OK]',until:new Date(Date.now()+3500000).toISOString()}));
  assert.equal(run(h),null);
});

test('LANE-OK state cannot bypass with negative prompt or after 60 minutes', t => {
  for (const extra of [{prompt:'[LANE-OK] 禁止'}, {at:new Date(Date.now()-3600001).toISOString()}]) {
    const h=setup('implement','claude-sonnet-5',{toolCalls:7,laneOk:true,...extra}); t.after(()=>fs.rmSync(h,{recursive:true,force:true}));
    assert.equal(run(h).hookSpecificOutput.permissionDecision,'deny');
  }
});

for (const tool_name of ['Bash', 'PowerShell']) {
  test(`${tool_name}: operator scripts neither count nor warn/deny`, t => {
    for (const toolCalls of [0, 3, 8, 100]) {
      const h = setup('implement', 'claude-opus-5', { toolCalls });
      t.after(() => fs.rmSync(h, { recursive: true, force: true }));
      const commands = [
        ...['click', 'paste', 'key', 'shot'].map(action => `powershell -STA -File ~/.claude/tools/line-pc-act.ps1 -Action ${action}`),
        'powershell -File ~/.claude/tools/line-send.ps1',
        ...['make-desktop-launcher', 'notify-kim', 'discord-dm', 'fleet-mail'].map(name => `node ~/.claude/tools/${name}.mjs`),
      ];
      for (const command of commands) {
        assert.equal(run(h, { tool_name, tool_input: tool_name === 'Bash' ? { command } : { script: command } }), null, command);
        assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.claude/session-lane/s.json'))).toolCalls, toolCalls);
      }
    }
  });
  test(`${tool_name}: scratchpad LINE wrappers are exempt only for single invocations`, t => {
    const h = setup('implement', 'claude-opus-5', { toolCalls: 100 });
    t.after(() => fs.rmSync(h, { recursive: true, force: true }));
    const dir = path.join(h, 'scratchpad'); fs.mkdirSync(dir);
    const file = path.join(dir, 'gui sequence.ps1');
    fs.writeFileSync(file, '& ~/.claude/tools/line-pc-act.ps1 -Action click');
    for (const command of [`powershell -STA -File "${file}"`, `pwsh -NoProfile -ExecutionPolicy Bypass -File '${file}'`, `& "${file}"`, `"${file}"`]) {
      assert.equal(run(h, { tool_name, tool_input: { command } }), null, command);
      assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.claude/session-lane/s.json'))).toolCalls, 100);
    }
    const outside = path.join(h, 'outside.ps1'); fs.copyFileSync(file, outside);
    const ordinary = path.join(dir, 'ordinary.ps1'); fs.writeFileSync(ordinary, 'Write-Output hello');
    let expected = 100;
    for (const command of [`powershell -File "${file}"; node build.mjs`, `powershell -File "${file}" && node build.mjs`, `powershell -File "${outside}"`, `powershell -File "${dir}/../outside.ps1"`, `powershell -File "${ordinary}"`, `powershell -File "${dir}/missing.ps1"`, 'node build.mjs']) {
      assert.equal(run(h, { tool_name, tool_input: { command } }).hookSpecificOutput.permissionDecision, 'deny', command);
      assert.equal(JSON.parse(fs.readFileSync(path.join(h, '.claude/session-lane/s.json'))).toolCalls, ++expected);
    }
  });
}
