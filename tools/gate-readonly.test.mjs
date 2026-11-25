import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { discoverGates, toolsDir } from './gate-contracts.mjs';
import { isReadonlyCommand } from './readonly-command.mjs';
import { evaluateGates } from './stop-gate-runner.mjs';
const commands=fs.readFileSync(new URL('./fixtures/readonly-commands.txt',import.meta.url),'utf8').split(/\r?\n/).filter(s=>s&&!s.startsWith('#'));
for(const name of discoverGates()) test(`${name}: full readonly corpus (Bash/PowerShell)`,async t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'gate-readonly-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 fs.mkdirSync(path.join(home,'.claude/session-lane'),{recursive:true});
 fs.writeFileSync(path.join(home,'.claude/session-lane/test.json'),JSON.stringify({lane:'implement',toolCalls:99}));
 fs.writeFileSync(path.join(home,'.claude/cost-enforce.json'),' {"mode":"block"}');
 const transcript=path.join(home,'transcript.jsonl');
 fs.writeFileSync(transcript,JSON.stringify({type:'assistant',message:{model:'claude-opus-5',content:[]}})+'\n');
 // A real deployment would be blocked in this fixture: no feedback form.
 fs.writeFileSync(path.join(home,'appsscript.json'),'{}');
 for(const command of commands) for(const tool_name of ['Bash','PowerShell']) {
  const input={hook_event_name:'PreToolUse',session_id:'test',cwd:home,tool_name,tool_input:{command},transcript_path:transcript};
  const r=spawnSync(process.execPath,[path.join(toolsDir,`${name}.mjs`)],{input:JSON.stringify(input),encoding:'utf8',timeout:10000,env:{...process.env,ORGIAST_HOME:home,ORGIAST_REPORT_LLM_GATE:'0',ORGIAST_HANDOFF_AUDIT:'off',CLAUDE_HEADLESS:'1'}});
  assert.equal(r.status,0,`${name}: ${command}: ${r.stderr}`);
  assert.doesNotMatch(r.stdout,/"permissionDecision"\s*:\s*"deny"|"decision"\s*:\s*"block"/,`${name}: ${command}`);
 }
});
test('compound writes never inherit the readonly exemption',()=>{
 for(const c of ['clasp deployments && clasp push','git push --dry-run; git push','gh pr view 1 > result','vercel ls | sh','git push $(touch file) --dry-run','clasp deploymentsExtra','vercel lsExtra']) assert.equal(isReadonlyCommand(c),false,c);
 for(const c of commands) assert.equal(isReadonlyCommand(c),true,c);
});
test('Stop children receive tool-only transcript and no assistant claim',async()=>{
 for(const command of commands) {
  const r=await evaluateGates({input:{},assistantText:'',humanText:'',transcriptRaw:JSON.stringify({type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command}}]}}),sessionId:'readonly'}, {mode:'off'});
  assert.deepEqual(r.results,[],command);
 }
});
