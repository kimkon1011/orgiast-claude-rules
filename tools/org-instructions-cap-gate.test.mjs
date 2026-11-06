import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { judge } from './org-instructions-cap-gate.mjs';
import { rolloutMode } from './gate-runtime.mjs';

test('passes when char count is present with trigger', () => {
  const result = judge('組織指示に追記します。追加案: 何か（現行+追記案=合計 2,740 字）');
  assert.equal(result.decision, 'pass');
});

test('blocks when trigger present but no char count', () => {
  const result = judge('組織指示に追記します。追加案: ここに新しいルールを追加する。');
  assert.equal(result.decision, 'block');
  assert.deepEqual(result.reasonCodes, ['ORG-INSTR-CHAR-CAP']);
});

test('passes when not about org instructions', () => {
  const result = judge('通常の応答です。特に問題ありません。');
  assert.equal(result.decision, 'pass');
});

test('passes when only citing org instructions (no trigger word)', () => {
  const result = judge('組織指示には第2条で…とある。したがってこの対応は不要。');
  assert.equal(result.decision, 'pass');
});

test('passes with 2,800字 notation', () => {
  const result = judge('組織指示に追記する。現行+追記=合計 2,800字');
  assert.equal(result.decision, 'pass');
});

test('passes with 字数 keyword', () => {
  const result = judge('組織指示に新設するルールの字数を確認した。');
  assert.equal(result.decision, 'pass');
});

test('blocks when only trigger words present without 組織指示', () => {
  const result = judge('以下を追加します。新たなルールです。');
  assert.equal(result.decision, 'pass');
});

test('reason message is descriptive', () => {
  const result = judge('組織指示に導入する。新しいルール。');
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /ORG-INSTR-CHAR-CAP/);
  assert.match(result.reason, /3,000/);
});

test('handles empty text', () => {
  const result = judge('');
  assert.equal(result.decision, 'pass');
});

test('handles null text', () => {
  const result = judge(null);
  assert.equal(result.decision, 'pass');
});

test('Stop protocol returns block JSON', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'org-cap-gate-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: '組織指示に追記します。新しいルール。' }] } }) + '\n');
  const run = input => spawnSync(process.execPath, ['tools/org-instructions-cap-gate.mjs'], { encoding: 'utf8', input: JSON.stringify(input), env: { ...process.env, ORGIAST_HOME: home } });
  const blocked = run({ transcript_path: transcript, session_id: 'test' });
  assert.equal(blocked.status, 0);
  assert.equal(JSON.parse(blocked.stdout).decision, 'block');
  assert.match(JSON.parse(blocked.stdout).reason, /ORG-INSTR-CHAR-CAP/);
  assert.equal(run({ transcript_path: transcript, last_assistant_message: '正常です' }).stdout, '');
  assert.equal(run({}).stdout, '');
  assert.equal(rolloutMode('org-instructions-cap-gate', { home, hostname: 'fresh-pc' }), 'deny');
});