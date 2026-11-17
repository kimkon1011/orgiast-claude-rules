import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { judge, HOOK_MATCHER } from './share-before-send-gate.mjs';
const url = 'https://docs.google.com/document/d/file123/edit';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude'));
  const ledgerPath = path.join(dir, '.claude/share-ledger.jsonl'); fs.writeFileSync(ledgerPath, '');
  return { dir, ledgerPath };
}
const message = (body = url) => ({ tool_name: 'mcp__claude_ai_Discord__send_dm', tool_input: { recipient_id: 'other', content: body } });
test('Google Forms public response URL passes without share evidence', async t => {
  const opts = fixture(t);
  const formsUrl = 'https://docs.google.com/forms/d/e/1FAIpQLScJdyNl1ryrNXvshdF1yVaOjDueiWmObdcPVydj1m-DhPjWTw/viewform?usp=pp_url&entry.1172257432=abc';
  assert.equal((await judge(message(formsUrl), opts)).decision, 'pass');
  // 通常のフォーム編集URLは引き続きブロック対象
  assert.equal((await judge(message('https://docs.google.com/forms/d/1x29rPbBs6ha4FU2w3_JKFdL7p88tkIY31l1_DP1j3qY/edit'), opts)).decision, 'block');
});
test('no link passes; Google link without evidence blocks', async t => {
  const opts = fixture(t);
  assert.equal((await judge(message('hello'), opts)).decision, 'pass');
  assert.equal((await judge(message(), opts)).decision, 'block');
  assert.match((await judge(message(), opts)).reason, /--id file123 --to/);
  assert.match((await judge(message(), opts)).reason, /--to syain@orgiast\.jp で全社員に共有/);
});
test('recent ledger passes, old or future timestamps do not', async t => {
  const opts = fixture(t);
  for (const [age, decision] of [[0, 'pass'], [30 * 86400000, 'pass'], [31 * 86400000, 'block'], [-1000, 'block']]) {
    const now = Date.now(); fs.writeFileSync(opts.ledgerPath, JSON.stringify({ ts: new Date(now - age).toISOString(), fileId: 'file123', emails: ['a@example.com'], role: 'commenter' }));
    assert.equal((await judge(message(), { ...opts, now })).decision, decision);
  }
});
test('all linked files need evidence', async t => {
  const opts = fixture(t);
  fs.writeFileSync(opts.ledgerPath, JSON.stringify({ ts: new Date().toISOString(), fileId: 'file123', emails: ['a@example.com'] }));
  assert.equal((await judge(message(url + ' https://drive.google.com/file/d/other/view'), opts)).decision, 'block');
});
test('transcript share_file or share CLI tool calls pass, prose and dry run do not', async t => {
  const opts = fixture(t); const transcript_path = path.join(opts.dir, 'transcript');
  for (const [block, decision] of [
    [{ type: 'tool_use', name: 'mcp__claude_ai_Google_Drive__share_file', input: { file_id: 'file123', email: 'a@example.com' } }, 'pass'],
    [{ type: 'tool_use', name: 'Bash', input: { command: 'node tools/drive-share.mjs --id file123 --to a@example.com' } }, 'pass'],
    [{ type: 'tool_use', name: 'PowerShell', input: { command: 'node tools/gdoc-publish.mjs --update file123 --share a@example.com' } }, 'pass'],
    [{ type: 'text', text: 'mcp__claude_ai_Google_Drive__share_file file123' }, 'block'],
    [{ type: 'tool_use', name: 'Bash', input: { command: 'node tools/drive-share.mjs --id file123 --to a@example.com --dry' } }, 'block'],
  ]) {
    fs.writeFileSync(transcript_path, JSON.stringify({ type: 'assistant', message: { content: [block] } }));
    assert.equal((await judge({ ...message(), transcript_path }, opts)).decision, decision);
  }
});
test('Bash and PowerShell body-file paths including spaces and relative cwd block', async t => {
  const opts = fixture(t); fs.writeFileSync(path.join(opts.dir, 'body text.txt'), url);
  for (const tool_name of ['Bash', 'PowerShell']) {
    const input = { tool_name, cwd: opts.dir, tool_input: { command: 'node tools/discord-dm.mjs user --body-file "body text.txt"' } };
    assert.equal((await judge(input, opts)).decision, 'block');
    input.tool_input.command = 'node tools/discord-dm.mjs user --body-file="body text.txt"';
    assert.equal((await judge(input, opts)).decision, 'block');
  }
});
test('all requested tools match and self-only Gmail passes', async t => {
  const opts = fixture(t);
  for (const name of ['mcp__claude_ai_Discord_1__reply_message', 'mcp__claude_ai_Discord__send_message', 'mcp__claude_ai_Gmail__forward', 'mcp__claude_ai_Gmail_2__update_draft', 'Bash', 'PowerShell']) assert.match(name, new RegExp(`^(?:${HOOK_MATCHER})$`));
  const input = { tool_name: 'mcp__claude_ai_Gmail__send_message', tool_input: { to: 'kim@orgiast.jp', body: url } };
  assert.equal((await judge(input, opts)).decision, 'pass');
  input.tool_input.cc = 'other@example.com'; assert.equal((await judge(input, opts)).decision, 'block');
});
test('CLI malformed input and missing body file fail open; malformed or missing ledger still denies', t => {
  const opts = fixture(t);
  const run = input => spawnSync(process.execPath, ['tools/share-before-send-gate.mjs'], { input, encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: opts.dir } });
  for (const raw of ['{broken', JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'node tools/discord-dm.mjs user --body-file /does-not-exist' } })]) {
    const result = run(raw); assert.equal(result.status, 0); assert.equal(result.stdout, ''); assert.equal(result.stderr.trim().split('\n').length, 1);
  }
  fs.writeFileSync(opts.ledgerPath, 'bad json');
  const deny = r => JSON.parse(r.stdout).hookSpecificOutput.permissionDecision;
  assert.equal(deny(run(JSON.stringify(message()))), 'deny');
  fs.unlinkSync(opts.ledgerPath);
  assert.equal(deny(run(JSON.stringify(message()))), 'deny');
});
test('CLI emits PreToolUse denial', t => {
  const opts = fixture(t);
  const result = spawnSync(process.execPath, ['tools/share-before-send-gate.mjs'], { input: JSON.stringify(message()), encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: opts.dir } });
  assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
});
// ── anyone-link check tests ──
test('anyone-public file passes with checkAnyone returning true', async t => {
  const opts = fixture(t);
  const r = await judge(message(), { ...opts, checkAnyone: async () => true });
  assert.equal(r.decision, 'pass');
  // 台帳に anyone-with-link が記録されている
  const ledger = fs.readFileSync(opts.ledgerPath, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  assert.ok(ledger.some(e => e.fileId === 'file123' && e.emails.includes('anyone-with-link') && e.via === 'anyone-link-check'));
});
test('non-public file blocks with checkAnyone returning false', async t => {
  const opts = fixture(t);
  const r = await judge(message(), { ...opts, checkAnyone: async () => false });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /--id file123 --to/);
});
test('checkAnyone failure blocks with failure reason', async t => {
  const opts = fixture(t);
  const r = await judge(message(), { ...opts, checkAnyone: async () => { throw new Error('API error'); } });
  assert.equal(r.decision, 'block');
  assert.match(r.reason, /リンク公開かの確認に失敗/);
});