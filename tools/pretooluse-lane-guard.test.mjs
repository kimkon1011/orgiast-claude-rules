import test from 'node:test'; import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
function setup(lane='implement', model='claude-fable-5', extra={}) { const home=fs.mkdtempSync(path.join(os.tmpdir(),'lane-')); fs.mkdirSync(path.join(home,'.claude','session-lane'),{recursive:true}); fs.writeFileSync(path.join(home,'.claude','session-lane','s.json'),JSON.stringify({lane,toolCalls:extra.toolCalls||0,laneOk:extra.laneOk})); fs.writeFileSync(path.join(home,'t.jsonl'),JSON.stringify({message:{model}})+'\n'); if(extra.config) fs.writeFileSync(path.join(home,'.claude','lane-guard.json'),JSON.stringify(extra.config)); return home; }
function run(home, overrides={}) { const input={session_id:'s',transcript_path:path.join(home,'t.jsonl'),tool_name:'Write',tool_input:{file_path:path.join(home,'x.js')},...overrides}; const r=spawnSync(process.execPath,['tools/pretooluse-lane-guard.mjs'],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,ORGIAST_HOME:home}}); return r.stdout.trim()?JSON.parse(r.stdout):null; }
test('カウントし warnAt 境界で警告',()=>{const h=setup('implement','claude-fable-5',{toolCalls:3}); assert.match(run(h).hookSpecificOutput.additionalContext,/4 回/);});
test('blockAt 境界でdeny',()=>{const h=setup('implement','claude-opus-5',{toolCalls:7}); assert.equal(run(h).hookSpecificOutput.permissionDecision,'deny');});
test('consultはblockしない',()=>{const h=setup('consult','claude-fable-5',{toolCalls:7}); assert.ok(!run(h).hookSpecificOutput.permissionDecision);});
test('LANE-OKはblockしない',()=>{const h=setup('bulk','claude-fable-5',{toolCalls:7,laneOk:true}); assert.ok(!run(h).hookSpecificOutput.permissionDecision);});
test('warn modeはblockしない',()=>{const h=setup('verify','claude-fable-5',{toolCalls:7,config:{mode:'warn'}}); assert.ok(!run(h).hookSpecificOutput.permissionDecision);});
test('非Fable/Opusは無干渉',()=>assert.equal(run(setup('implement','claude-sonnet-5')),null));
test('subagentsは除外',()=>{const h=setup(); assert.equal(run(h,{transcript_path:path.join(h,'subagents','x.jsonl')}),null);});
test('委譲コマンドは除外',()=>{const h=setup(); assert.equal(run(h,{tool_name:'Bash',tool_input:{command:'node tools/codex-do.mjs --prompt-file x'}}),null);});
test('read-onlyは除外',()=>{const h=setup(); assert.equal(run(h,{tool_name:'Bash',tool_input:{command:'git status'}}),null);});
test('.md編集は除外',()=>{const h=setup(); assert.equal(run(h,{tool_input:{file_path:path.join(h,'x.md')}}),null);});
test('生存レーンありは旧bypass条件でもdeny',()=>{const h=setup('implement','claude-opus-5',{toolCalls:7});fs.writeFileSync(path.join(h,'.claude/provider-cooldown.json'),JSON.stringify({codex:{until:Date.now()+3600000,reason:'usage_limit_no_fallback'}}));fs.writeFileSync(path.join(h,'.claude/lane-health.json'),JSON.stringify({implementOrder:['deepseek']}));const r=run(h).hookSpecificOutput;assert.equal(r.permissionDecision,'deny');assert.match(r.permissionDecisionReason,/deepseek.*codex-do\.mjs/);});
test('全滅かつ新鮮なprobeはallowとcontext',()=>{const h=setup('implement','claude-opus-5',{toolCalls:7});fs.writeFileSync(path.join(h,'.claude/lane-health.json'),JSON.stringify({implementOrder:[],probedAt:new Date().toISOString()}));const r=run(h).hookSpecificOutput;assert.equal(r.permissionDecision,undefined);assert.match(r.additionalContext,/\[LANE-FALLBACK\].*sonnet/);});
test('全滅かつ古いprobeはdeny',()=>{const h=setup('implement','claude-opus-5',{toolCalls:7});fs.writeFileSync(path.join(h,'.claude/lane-health.json'),JSON.stringify({implementOrder:[],probedAt:new Date(Date.now()-3600000).toISOString()}));const r=run(h).hookSpecificOutput;assert.equal(r.permissionDecision,'deny');assert.match(r.permissionDecisionReason,/lane-doctor\.mjs --probe/);});
test('lane-doctor呼び出しは委譲扱い',()=>{const h=setup('implement','claude-opus-5',{toolCalls:100});assert.equal(run(h,{tool_name:'Bash',tool_input:{command:'node tools/lane-doctor.mjs --probe'}}),null);});

test('Codex alive deny points directly to codex-do without unavailable wording',t=>{
  const h=setup('implement','claude-opus-5',{toolCalls:7});
  t.after(()=>fs.rmSync(h,{recursive:true,force:true}));
  fs.writeFileSync(path.join(h,'.claude/lane-health.json'),JSON.stringify({implementOrder:['codex','deepseek']}));
  const r=run(h).hookSpecificOutput;
  assert.equal(r.permissionDecision,'deny');
  assert.match(r.permissionDecisionReason,/Codex は生きている。node tools\/codex-do\.mjs --prompt-file <指示> --cwd <対象> へ渡せ/);
  assert.doesNotMatch(r.permissionDecisionReason,/使えない時/);
});
