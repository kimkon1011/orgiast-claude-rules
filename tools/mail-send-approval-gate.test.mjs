import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { judge } from './mail-send-approval-gate.mjs';

function createFixture() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mail-gate-test-'));
  const transcriptPath = path.join(tmpDir, 'transcript.jsonl');

  return {
    tmpDir,
    transcriptPath,
    writeTranscript(entries) {
      const content = entries.map(e => JSON.stringify(e)).join('\n');
      fs.writeFileSync(transcriptPath, content, 'utf8');
    },
    cleanup() {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  };
}

test('mail-send-approval-gate: non-matching tools pass', () => {
  const res = judge({ tool_name: 'Write', tool_input: { file_path: 'test.txt' } });
  assert.equal(res.decision, 'pass');
});

test('mail-send-approval-gate: create_draft passes', () => {
  const res = judge({ tool_name: 'mcp__claude_ai_Gmail__create_draft', tool_input: { body: 'Draft body' } });
  assert.equal(res.decision, 'pass');
});

test('mail-send-approval-gate: internal notification shell tools pass', () => {
  const res = judge({ tool_name: 'Bash', tool_input: { command: 'node tools/fleet-mail.mjs --send' } });
  assert.equal(res.decision, 'pass');
});

test('mail-send-approval-gate: blocks send when body not displayed in assistant message', () => {
  const fix = createFixture();
  try {
    fix.writeTranscript([
      { type: 'user', message: { role: 'user', content: '送信して' } }
    ]);

    const res = judge({
      tool_name: 'mcp__claude_ai_Gmail__send_message',
      tool_input: { body: 'こんにちは。見積書を送付いたします。' },
      transcript_path: fix.transcriptPath
    });

    assert.equal(res.decision, 'block');
    assert.match(res.reason, /本文の全文をチャットに表示/);
  } finally {
    fix.cleanup();
  }
});

test('mail-send-approval-gate: blocks send when displayed but user approval missing', () => {
  const fix = createFixture();
  try {
    fix.writeTranscript([
      { type: 'assistant', message: { role: 'assistant', content: '以下の本文で送ります:\nこんにちは。見積書を送付いたします。' } },
      { type: 'user', message: { role: 'user', content: 'ちょっと待って' } }
    ]);

    const res = judge({
      tool_name: 'mcp__claude_ai_Gmail__send_message',
      tool_input: { body: 'こんにちは。見積書を送付いたします。' },
      transcript_path: fix.transcriptPath
    });

    assert.equal(res.decision, 'block');
  } finally {
    fix.cleanup();
  }
});

test('mail-send-approval-gate: passes send when body displayed and user approves', () => {
  const fix = createFixture();
  try {
    fix.writeTranscript([
      { type: 'assistant', message: { role: 'assistant', content: '以下の本文で送信します:\nこんにちは。見積書を送付いたします。' } },
      { type: 'user', message: { role: 'user', content: '送ってよいです。' } }
    ]);

    const res = judge({
      tool_name: 'mcp__claude_ai_Gmail__send_message',
      tool_input: { body: 'こんにちは。見積書を送付いたします。' },
      transcript_path: fix.transcriptPath
    });

    assert.equal(res.decision, 'pass');
  } finally {
    fix.cleanup();
  }
});

import { judgeLive } from './mail-send-approval-gate.mjs';
const evidence = body => [{type:'assistant',content:body},{type:'user',content:'送ってよいです。'}];
test('unknown body, no transcript and draft ID without readback all block', () => {
  for (const input of [
    {tool_name:'mcp__claude_ai_Gmail__reply',tool_input:{}},
    {tool_name:'mcp__claude_ai_Gmail__forward',tool_input:{body:'x'}},
    {tool_name:'Bash',tool_input:{command:'node tools/gmail-draft.mjs --send draft123'}}
  ]) assert.equal(judge(input).decision,'block');
});
test('middle-only changes and revoked approval block', () => {
  const body = 'a'.repeat(200) + 'original' + 'z'.repeat(100);
  assert.equal(judge({tool_name:'mcp__claude_ai_Gmail__send_message',tool_input:{body:body.replace('original','edited')},transcript:evidence(body)}).decision,'block');
  assert.equal(judge({tool_name:'mcp__claude_ai_Gmail__send_message',tool_input:{body},transcript:[...evidence(body),{type:'user',content:'送ってはいけない'}]}).decision,'block');
});
test('real draft readback is used, not a shell-supplied substitute body', async () => {
  const input = {tool_name:'Bash',tool_input:{command:'node tools/gmail-draft.mjs --send draft123 --body "approved"'},transcript:evidence('approved')};
  let target;
  assert.equal((await judgeLive(input,{loadDraft:async t => { target=t; return 'approved'; }})).decision,'pass');
  assert.equal(target.draftId,'draft123');
  assert.equal(target.user,'seisaku-team@orgiast.jp');
  assert.equal((await judgeLive(input,{loadDraft:async () => 'changed'})).decision,'block');
  assert.equal((await judgeLive(input,{loadDraft:async () => { throw Error('403'); }})).decision,'block');
});
test('notifications do not exempt another send in the same shell', async () => {
  const result = await judgeLive({tool_name:'Bash',tool_input:{command:'node tools/kim-inbox.mjs --add; node tools/gmail-draft.mjs --send draft1'},transcript:[]},{loadDraft:async () => 'body'});
  assert.equal(result.decision,'block');
});
test('draft creation and forward-draft creation stay allowed', () => {
  for (const command of ['node tools/gmail-draft.mjs --to a@b.com --body x','node tools/gmail-draft.mjs --forward msg --to a@b.com']) assert.equal(judge({tool_name:'Bash',tool_input:{command}}).decision,'pass');
});

import { draftBody } from './mail-send-approval-gate.mjs';
test('live MIME body retains quotes and forwarding content, excludes attachments',()=>{
  const data=s=>Buffer.from(s).toString('base64url');
  const body='ご確認ください\n\n> 引用された契約内容\n---------- Forwarded message ---------\n全文';
  assert.equal(draftBody({mimeType:'multipart/mixed',parts:[{mimeType:'text/plain',body:{data:data(body)}},{mimeType:'text/plain',filename:'secret.txt',body:{data:data('attachment')}}]}),body);
});
