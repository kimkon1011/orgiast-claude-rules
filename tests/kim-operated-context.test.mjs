import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(root, 'tools', 'kim-operated-context.mjs');

function run(account, withConfig = true) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-operated-context-'));
  if (withConfig) fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: account } }));
  const result = spawnSync(process.execPath, [script], {
    input: '{}',
    encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: home },
  });
  fs.rmSync(home, { recursive: true, force: true });
  return result;
}

test('kim 操作アカウントでは本人コンテキストを出力する', () => {
  const result = run('cr@orgiast.jp');
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout.trim());
  assert.equal(output.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(output.hookSpecificOutput.additionalContext, /cr@orgiast\.jp/);
  assert.match(output.hookSpecificOutput.additionalContext, /kim＝金功勇（社長）本人/);
});

test('社員アカウントでは何も出力しない', () => {
  const result = run('sawada@orgiast.jp');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('.claude.json が無くても何も出力せず正常終了する', () => {
  const result = run('', false);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
