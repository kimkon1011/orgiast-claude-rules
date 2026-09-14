import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const runner = fileURLToPath(new URL('./stop-gate-runner.mjs', import.meta.url));
const request = 'GitHub の画面で Merge をクリックしてください。';

function invoke(home, sessionId, text, extra = {}) {
  return spawnSync(process.execPath, [runner], {
    input: JSON.stringify({ session_id: sessionId, assistant_text: text, ...extra }),
    encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_HANDOFF_AUDIT: 'off' },
  });
}

test('複数gateの理由を1つのblockへ合流する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-combined-'));
  const result = invoke(home, 'combined', request);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.decision, 'block');
  assert.match(output.reason, /### manual-request-fullsteps-gate[\s\S]*FULL-STEPS/);
  assert.match(output.reason, /### handoff-info-guard[\s\S]*HANDOFF-INFO-GUARD/);
  assert.match(output.reason, /ピギーバック・ヒント/);
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.ok(record.blockedBy.includes('manual-request-fullsteps-gate'));
  assert.ok(record.blockedBy.includes('handoff-info-guard'));
});

test('同一sessionの3回目はretry-capでpassする', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-cap-'));
  assert.equal(JSON.parse(invoke(home, 'cap', request).stdout).decision, 'block');
  assert.equal(JSON.parse(invoke(home, 'cap', request).stdout).decision, 'block');
  assert.equal(invoke(home, 'cap', request).stdout, '');
  const records = fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(records.map(({ verdict }) => verdict), ['block', 'block', 'retry-cap']);
});

test('stop_hook_activeは評価せずskippedでpassする', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-active-'));
  assert.equal(invoke(home, 'active', request, { stop_hook_active: true }).stdout, '');
  const record = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'stop-gate-runner-ledger.jsonl'), 'utf8'));
  assert.equal(record.verdict, 'skipped');
  assert.deepEqual(record.reasonCodes, ['stop_hook_active']);
});

test('次の行があればピギーバック・ヒントを重ねない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-hint-'));
  const output = JSON.parse(invoke(home, 'hint', `${request}\n次に kim がすること: Merge をクリック`).stdout);
  assert.doesNotMatch(output.reason, /ピギーバック・ヒント/);
});

test('外部状態の否定断定を EXTERNAL-STATE で block する', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-external-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const output = invoke(home, 'external', 'GA4 は存在しない可能性が高い');
  assert.equal(output.status, 0, output.stderr);
  const verdict = JSON.parse(output.stdout);
  assert.equal(verdict.decision, 'block');
  assert.match(verdict.reason, /\[EXTERNAL-STATE\]/);
});

test('assistant_text と transcript_path の併用でも直接照会証拠を読む', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-runner-evidence-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcript = path.join(home, 'transcript.jsonl');
  fs.writeFileSync(transcript, [
    { type: 'user', message: { role: 'user', content: 'GA4 を確認して' } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'gcloud projects list' } }] } },
  ].map(entry => JSON.stringify(entry)).join('\n'));
  const output = invoke(home, 'evidence', 'GA4 は存在しない', { transcript_path: transcript });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(output.stdout, '');
});
