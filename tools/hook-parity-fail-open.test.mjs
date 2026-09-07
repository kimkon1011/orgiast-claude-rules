import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { evaluateHandoffDetail } from './handoff-detail-guard.mjs';

const repo = path.resolve('.');
const hooks = [
  'handoff-quality-gate.mjs',
  'handoff-investigation-gate.mjs',
  'negative-claim-gate.mjs',
  'pretooluse-headless-background.mjs',
  'pretooluse-serial-investigation.mjs',
  'automation-first-reminder.mjs',
  'credentials-reminder.mjs',
  'handoff-detail-guard.mjs',
];

function run(name, input, home) {
  return spawnSync(process.execPath, [path.join(repo, 'tools', name)], {
    input,
    encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: home, USERPROFILE: home, CLAUDE_HEADLESS: '' },
  });
}

test('手間削減hook 8本は依存・envなし、空stdinでfail-openする', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-parity-empty-'));
  const missingHome = path.join(root, 'missing-home');
  for (const name of hooks) {
    const result = run(name, '', missingHome);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.equal(result.stdout, '', `${name} must be silent`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('手間削減hook 8本は不正JSONでfail-openする', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-parity-bad-json-'));
  const missingHome = path.join(root, 'missing-home');
  for (const name of hooks) {
    const result = run(name, '{broken', missingHome);
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
    assert.equal(result.stdout, '', `${name} must not emit a hook decision`);
  }
  fs.rmSync(root, { recursive: true, force: true });
});

test('automation-first-reminderは手作業依頼promptでadditionalContextを返す', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-first-'));
  const result = run('automation-first-reminder.mjs', JSON.stringify({ prompt: '設定画面で手作業をしてください' }), home);
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(output.hookSpecificOutput.additionalContext, /AUTOMATION-FIRST/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('handoff-quality-gateはledgerディレクトリ不在でもexit 0', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-quality-no-ledger-'));
  const home = path.join(root, 'home-without-claude');
  const input = { assistant_text: 'Vercel Dashboardを開いて設定してください。', session_id: 'no-ledger' };
  const result = run('handoff-quality-gate.mjs', JSON.stringify(input), home);
  assert.equal(result.status, 0, result.stderr);
  fs.rmSync(root, { recursive: true, force: true });
});

test('handoff-detail-guardは元ps1相当の代表ケースをblock/passする', () => {
  const commandRequest = '以下を貼ってください。\n```bash\ngit clone example\n```';
  assert.equal(evaluateHandoffDetail(commandRequest).decision, 'block');
  const fullSteps = 'PowerShellを開いて、以下を貼ってください。\n```bash\ngit clone example\n```';
  assert.equal(evaluateHandoffDetail(fullSteps).decision, 'pass');
});
