import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { toolsDir, repoDir } from './gate-contracts.mjs';
import { judge as feedback } from './feedback-form-gate.mjs';
import { run as stop } from './stop-gate-runner.mjs';
import { findBrokenRawUrl } from './url-format-guard.mjs';
import { evaluateHandoffDetail } from './handoff-detail-guard.mjs';
import { findLocalDocLinks } from './doc-link-drive-guard.mjs';

function fixture(t){const home=fs.mkdtempSync(path.join(os.tmpdir(),'gate-recommend-'));t.after(()=>fs.rmSync(home,{recursive:true,force:true}));return home;}
function hook(name,input,home){const r=spawnSync(process.execPath,[path.join(toolsDir,name+'.mjs')],{input:JSON.stringify(input),encoding:'utf8',env:{...process.env,ORGIAST_HOME:home,CLAUDE_HEADLESS:'1'}});assert.equal(r.status,0,r.stderr);return r.stdout;}
test('feedback GAS INSTALL method A copies actual templates and passes deploy',t=>{
 const home=fixture(t);fs.writeFileSync(path.join(home,'.clasp.json'),'{"rootDir":"src"}');fs.mkdirSync(path.join(home,'src/ui'),{recursive:true});
 assert.equal(feedback({command:'clasp push',cwd:home},{home}).deny,true);
 const doc=fs.readFileSync(path.join(repoDir,'packages/feedback-gas/INSTALL.md'),'utf8');assert.match(doc,/src\/FeedbackRelay\.js/);
 fs.copyFileSync(path.join(repoDir,'packages/feedback-gas/templates/FeedbackRelay.js'),path.join(home,'src/FeedbackRelay.js'));
 fs.copyFileSync(path.join(repoDir,'packages/feedback-gas/templates/FeedbackForm.html'),path.join(home,'src/ui/FeedbackForm.html'));
 assert.equal(feedback({command:'clasp push',cwd:home},{home}).deny,false);
});
test('feedback widget INSTALL executes real installer; documented registry step clears denial',t=>{
 const home=fixture(t);fs.writeFileSync(path.join(home,'package.json'),'{"dependencies":{"next":"15.0.0"}}');fs.mkdirSync(path.join(home,'app'));
 fs.writeFileSync(path.join(home,'app/layout.tsx'),'export default function Layout({ children }) { return <html><body>{children}</body></html>; }');
 assert.equal(feedback({command:'vercel deploy',cwd:home},{home}).deny,true);
 const result=spawnSync(process.execPath,[path.join(repoDir,'packages/feedback-widget/install.mjs'),'--target',home,'--app-name','fixture','--owner-discord-id','123456789012345678'],{encoding:'utf8',env:{...process.env,ORGIAST_HOME:home}});
 assert.equal(result.status,0,result.stderr);
 const registry=path.join(home,'registry.json');fs.writeFileSync(registry,'{}');
 assert.equal(feedback({command:'vercel deploy',cwd:home},{home,registryFile:registry,env:{}}).deny,true);
 fs.writeFileSync(registry,'{"fixture":"example/app"}');
 assert.equal(feedback({command:'vercel deploy',cwd:home},{home,registryFile:registry,env:{}}).deny,false);
});
test('autopilot SKILL recommended codex-do invocation passes active delegation gates',t=>{
 const home=fixture(t);fs.mkdirSync(path.join(home,'.claude/session-lane'),{recursive:true});fs.writeFileSync(path.join(home,'.claude/cost-enforce.json'),'{"mode":"block"}');
 fs.writeFileSync(path.join(home,'.claude/session-lane/test.json'),'{"lane":"implement","toolCalls":99}');
 const transcript=path.join(home,'transcript.jsonl');fs.writeFileSync(transcript,JSON.stringify({type:'assistant',message:{model:'claude-opus-5',content:[]}}));
 const skill=fs.readFileSync(path.join(repoDir,'skills/autopilot/SKILL.md'),'utf8');const command=skill.match(/`(node "<repo>\/tools\/codex-do\.mjs"[^`]+)`/)?.[1];assert.ok(command);
 for(const gate of ['pretooluse-lane-guard','pretooluse-bash-delegation','pretooluse-headless-background']) {
  const input={session_id:'test',transcript_path:transcript,tool_name:'Bash',tool_input:{command}};
  if(gate==='pretooluse-lane-guard') assert.match(hook(gate,{...input,tool_input:{command:'node arbitrary-write.mjs'}},home),/"deny"/);
  if(gate==='pretooluse-headless-background') assert.match(hook(gate,{...input,tool_input:{command,run_in_background:true}},home),/"deny"/);
  assert.doesNotMatch(hook(gate,input,home),/"deny"/);
 }
});
test('session-close SKILL closing steps pass Stop and formatting gates',async t=>{
 const home=fixture(t);const old=process.env.ORGIAST_HOME;process.env.ORGIAST_HOME=home;t.after(()=>{if(old===undefined)delete process.env.ORGIAST_HOME;else process.env.ORGIAST_HOME=old;});
 const skill=fs.readFileSync(path.join(repoDir,'skills/session-close/SKILL.md'),'utf8');assert.match(skill,/close-session\.mjs/);
 const text='1. 私が close-session.mjs --session fixture を実行します。\n2. 新しいタブで Enter を押してください。\n3. このタブを ✕ で閉じてください。/clear は使わないでください。';
 const r=await stop({assistant_text:text,session_id:'fixture'},{assistantText:text,humanText:'閉じて',raw:''},{mode:'off',policyOptions:{notify:async()=>({delivered:'dm'})}});
 assert.notEqual(r.decision,'block');assert.equal(findBrokenRawUrl(text).decision,'pass');assert.equal(evaluateHandoffDetail(text).decision,'pass');
});
test('published Doc link and Markdown URL remedy pass corresponding guards',()=>{
 assert.ok(findLocalDocLinks('[報告](/tmp/report.md)').length);
 const text='[報告](https://docs.google.com/document/d/TEST_ONLY/edit)（**作業アカウント**で開く）';
 assert.deepEqual(findLocalDocLinks(text),[]);assert.equal(findBrokenRawUrl(text).decision,'pass');
 assert.equal(findBrokenRawUrl('https://example.invalidです').decision,'block');
});
