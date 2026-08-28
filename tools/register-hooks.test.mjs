import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('既存PowerShell hookへExecutionPolicy Bypassを補いcost-loopをmjsへ移行する', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ command: 'powershell -NoProfile -NonInteractive -File "C:\\x\\cost-loop.ps1"' }] }],
    UserPromptSubmit: [{ hooks: [{ command: 'pwsh -NoProfile -File "C:\\x\\custom.ps1"' }] }],
    Stop: [{ hooks: [{ command: 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\x\\done.ps1"' }] }],
  } }));
  const stdout = execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo } });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const commands = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((group) => group.hooks || [])).map((hook) => hook.command);
  assert.ok(commands.some((command) => command.includes('cost-loop.mjs')));
  assert.ok(!commands.some((command) => command.includes('cost-loop.ps1')));
  assert.ok(commands.find((command) => command.includes('custom.ps1')).includes('-NoProfile -ExecutionPolicy Bypass'));
  assert.equal((commands.find((command) => command.includes('done.ps1')).match(/-ExecutionPolicy Bypass/gi) || []).length, 1);
  assert.match(stdout, /hook修復: 実行ポリシー1件 \/ cost-loop移行1件/);
  fs.rmSync(home, { recursive: true, force: true });
});
