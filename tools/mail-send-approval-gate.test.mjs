import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { judge, APPROVAL_MISSING_REASON, BODY_NOT_SHOWN_REASON } from './mail-send-approval-gate.mjs';
import { bodyHash } from './lib/send-approval.mjs';

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
    assert.equal(res.reason, BODY_NOT_SHOWN_REASON);
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

test('headless LINE send blocks, matching marker passes, and dry-run passes', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'send-marker-'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'line-body-'));
  t.after(() => { fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(cwd, { recursive: true, force: true }); });
  fs.writeFileSync(path.join(cwd, 'body.txt'), '社外向け本文\n', 'utf8');
  const input = { tool_name: 'Bash', cwd, tool_input: { command: 'node tools/line-group-send.mjs --group test --text-file body.txt' } };
  const env = { CLAUDE_HEADLESS: '1', ORGIAST_HOME: home };
  assert.equal(judge(input, { env, home }).decision, 'block');
  const hash = bodyHash('社外向け本文\n');
  fs.mkdirSync(path.join(home, '.claude', 'send-approvals'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'send-approvals', `${hash}.json`), JSON.stringify({ approvedAt: '2026-11-09T12:00:00Z', kimQuote: 'この本文で送って', bodyHash: hash }));
  assert.equal(judge(input, { env, home }).decision, 'pass');
  fs.writeFileSync(path.join(cwd, 'body.txt'), '改変本文', 'utf8');
  assert.equal(judge(input, { env, home }).decision, 'block');
  assert.equal(judge({ ...input, tool_input: { command: `${input.tool_input.command} --dry-run` } }, { env, home }).decision, 'pass');
});

test('other outbound send CLIs are covered in headless sessions', t => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'other-send-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  fs.writeFileSync(path.join(cwd, 'body.txt'), '本文', 'utf8');
  const options = { env: { ORGIAST_HEADLESS_JOB: 'auto-progress:scheduled-start' }, home: cwd };
  for (const command of [
    'node tools/line-channel.mjs --to C1 --body-file body.txt --send',
    'node tools/beeper-send.mjs --chat c1 --body-file body.txt --queue-id q --receipt r',
    'node tools/discord-dm.mjs vendor --body-file body.txt',
  ]) assert.equal(judge({ tool_name: 'Bash', cwd, tool_input: { command } }, options).decision, 'block');
});

import { draftBody } from './mail-send-approval-gate.mjs';
test('live MIME body retains quotes and forwarding content, excludes attachments',()=>{
  const data=s=>Buffer.from(s).toString('base64url');
  const body='ご確認ください\n\n> 引用された契約内容\n---------- Forwarded message ---------\n全文';
  assert.equal(draftBody({mimeType:'multipart/mixed',parts:[{mimeType:'text/plain',body:{data:data(body)}},{mimeType:'text/plain',filename:'secret.txt',body:{data:data('attachment')}}]}),body);
});

const multilineBody = '宛名\n\n本文の中間行\n末尾';
function judgeShown(shown, approval = '送って', body = multilineBody) {
  return judge({
    tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: { body },
    transcript: [{ type: 'assistant', content: shown }, { type: 'user', content: approval }]
  });
}
for (const prefix of ['> ', '>> ', '> > ']) {
  test(`body displayed with ${prefix} blockquote passes`, () => {
    assert.equal(judgeShown(multilineBody.split('\n').map(line => prefix + line).join('\n')).decision, 'pass');
  });
}
test('body displayed inside code fences passes', () => {
  assert.equal(judgeShown('```text\n' + multilineBody + '\n```').decision, 'pass');
});
test('normalization applies to draft and assistant, including line endings and blank lines', () => {
  const draft = '```text\r\n> > 宛名  \r\n> > \r\n> > \r\n> > 本文の中間行\t\r\n> > 末尾\r\n```';
  assert.equal(judgeShown(multilineBody, 'おくって', draft).decision, 'pass');
  assert.equal(judgeShown(draft).decision, 'pass');
});
test('changed middle line and partial body return body-not-shown reason', () => {
  for (const shown of [multilineBody.replace('本文の中間行', '変更した中間行'), '宛名\n\n末尾']) {
    assert.deepEqual(judgeShown(shown), { decision: 'block', reason: BODY_NOT_SHOWN_REASON });
  }
});
test('ambiguous latest turn returns approval-missing reason', () => {
  assert.deepEqual(judgeShown(multilineBody, '了解'), { decision: 'block', reason: APPROVAL_MISSING_REASON });
});
test('quoted draft and reaffirmation question pass together', () => {
  assert.equal(judgeShown(multilineBody.split('\n').map(line => '> ' + line).join('\n'), '送ってといったのに、送られない理由はなに？').decision, 'pass');
});
test('body displayed before an intervening human turn does not authorize sending', () => {
  const transcript = [...evidence(multilineBody), { type: 'user', content: '送って' }];
  assert.deepEqual(judge({ tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: { body: multilineBody }, transcript }), { decision: 'block', reason: BODY_NOT_SHOWN_REASON });
});
