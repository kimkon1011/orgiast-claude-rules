import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { judge } from './oneoff-send-gate.mjs';
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'oneoff gate-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true})); return root; }
const input=(cwd,command,tool_name='PowerShell')=>({cwd,tool_name,tool_input:{command}});
for (const [name,source] of [
  ['Beeper',"import { sendMessage, listMessages } from 'file:///C:/repo/tools/beeper-api.mjs'; await sendMessage(chat,text);"],
  ['Beeper POST',"fetch('/v1/chats/' + chat + '/messages', { method: 'POST' });"],
  ['Discord',"fetch('https://discord.com/api/v10/channels/1/messages', { method: 'POST' });"],
  ['Gmail',"fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send');"],
  ['LINE',"fetch('https://api.line.me/v2/bot/message/push');"],
]) test(`${name} の使い捨て送信を停止`, t=>{
  const root=fixture(t),file=path.join(root,'send job.mjs'); fs.writeFileSync(file,source);
  for(const tool of ['Bash','PowerShell']) assert.equal(judge(input(root,`node "${file}" --foo bar`,tool)).decision,'block');
});
test('読み取り専用・読めないファイルは通す',t=>{
  const root=fixture(t); fs.writeFileSync(path.join(root,'read.cjs'),"import { listMessages } from './beeper-api.mjs'; await listMessages(chat);");
  assert.equal(judge(input(root,'node read.cjs')).decision,'pass'); assert.equal(judge(input(root,'node missing.js')).decision,'pass');
});
test('tools正規入口だけ除外・偽toolsは停止',t=>{
  const root=fixture(t),dir=path.join(root,'tools'); fs.mkdirSync(dir); fs.writeFileSync(path.join(dir,'beeper-send.mjs'),"import { sendMessage } from './beeper-api.mjs'; sendMessage(chat,text);");
  assert.equal(judge(input(root,'node tools/beeper-send.mjs')).decision,'block');
  fs.writeFileSync(path.join(root,'.git'),'gitdir: fixture'); assert.equal(judge(input(root,'node tools/beeper-send.mjs')).decision,'pass');
});
test('node.exe・引数・別cwd・CLI exit2 と理由',t=>{
  const root=fixture(t),file=path.join(root,'send.js'); fs.writeFileSync(file,"import { sendMessage } from './beeper-api.mjs'; sendMessage(chat,text);");
  const event=input(root,`& "${process.execPath}" --no-warnings "${file}"`); assert.equal(judge(event).decision,'block');
  const result=spawnSync(process.execPath,['tools/oneoff-send-gate.mjs'],{input:JSON.stringify(event),encoding:'utf8'});
  assert.equal(result.status,2); assert.match(result.stdout,/permissionDecision.*deny/); assert.match(result.stderr,/使い捨て/);
});
