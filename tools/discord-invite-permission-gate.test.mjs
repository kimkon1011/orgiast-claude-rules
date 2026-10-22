import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateInvitePermissions, run } from './hooks/discord-invite-permission-gate.mjs';

const link = (permissions, id = '1511684767546871818') => `https://discord.com/oauth2/authorize?client_id=${id}&scope=bot&permissions=${permissions}`;
test('狭いリンクをblockし必要権限を案内', () => {
  const result = evaluateInvitePermissions(`招待: [Bot](${link('274877975552')})`);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /permissions=8/);
});
test('Administratorと上位ビットを持つリンクは通過', () => {
  for (const bits of ['8', '274877975560', String((1n << 60n) | 8n)]) assert.equal(evaluateInvitePermissions(link(bits)).decision, 'pass');
});
test('未登録idとリンク無しは通過', () => {
  assert.equal(evaluateInvitePermissions(link('0', '999')).decision, 'pass');
  assert.equal(evaluateInvitePermissions('リンク無し').decision, 'pass');
  assert.equal(evaluateInvitePermissions(link('8') + '。').decision, 'pass');
});
test('引数順序・HTMLエスケープ・複数リンクでも検知', () => {
  assert.equal(evaluateInvitePermissions(`${link('8')} https://discord.com/oauth2/authorize?permissions=0&amp;client_id=1511684767546871818`).decision, 'block');
});
test('Stop入力とtranscript末尾のassistant本文を評価', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'invite-gate-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'assistant', message: { content: [{ type: 'text', text: link('0') }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text: link('8') }] } },
  ].map(v => JSON.stringify(v)).join('\n'));
  assert.equal(run({ transcript_path: transcript }).decision, 'pass');
  assert.equal(run({ last_assistant_message: link('0'), transcript_path: transcript }).decision, 'block');
});
test('登録済みStop runnerは再Stopでも権限不足リンクをblock', () => {
  const result = spawnSync(process.execPath, ['tools/stop-gate-runner.mjs'], {
    input: JSON.stringify({ last_assistant_message: link('0'), stop_hook_active: true }), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).decision, 'block');
});
