import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluateLineBroadcastGuard } from './pretooluse-line-broadcast-guard.mjs';

const script = fileURLToPath(new URL('./pretooluse-line-broadcast-guard.mjs', import.meta.url));
const input = (tool_name, tool_input, transcript_path) => ({ tool_name, tool_input, transcript_path });

test('Bash の broadcast を deny する', () => {
  assert.equal(evaluateLineBroadcastGuard(input('Bash', { command: 'curl https://api.line.me/v2/bot/message/broadcast' })).hookSpecificOutput.permissionDecision, 'deny');
});

test('Write content の narrowcast を deny する', () => {
  assert.equal(evaluateLineBroadcastGuard(input('Write', { content: 'POST /v2/bot/message/narrowcast' })).hookSpecificOutput.permissionDecision, 'deny');
});

test('push URL は素通りする', () => {
  assert.equal(evaluateLineBroadcastGuard(input('PowerShell', { command: 'https://api.line.me/v2/bot/message/push' })), null);
});

test('assistant の解除トークンが transcript にあれば素通りする', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'line-broadcast-'));
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: '[LINE-BROADCAST-OK]' }] } }));
  assert.equal(evaluateLineBroadcastGuard(input('Bash', { command: 'curl /v2/bot/message/broadcast' }, transcript)), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('壊れた JSON は fail-open', () => {
  const result = spawnSync(process.execPath, [script], { input: '{broken', encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
