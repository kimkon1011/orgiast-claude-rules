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

test('session-relaunch hook は同期で1本だけ登録され、再実行で重複しない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-relaunch-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const second = execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const hooks = settings.hooks.SessionStart.flatMap((group) => group.hooks || [])
    .filter((hook) => String(hook.command).includes('session-relaunch'));
  assert.equal(hooks.length, 1);
  assert.match(hooks[0].command, /session-relaunch\.mjs" --hook$/);
  assert.equal(hooks[0].timeout, 10);
  assert.equal('async' in hooks[0], false);
  assert.match(second, /hook は既に登録済み\(変更なし\)/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('report-length-gate hook は timeout 10 で Stop に登録される', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-report-length-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], {
    encoding: 'utf8',
    env: { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo },
  });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const hooks = settings.hooks.Stop.flatMap((group) => group.hooks || [])
    .filter((hook) => String(hook.command).includes('report-length-gate.mjs'));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].timeout, 10);
  assert.equal('async' in hooks[0], false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('gtasks-pending-notice hook は同期かつtimeout 15で1本だけ登録される', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-gtasks-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const second = execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const hooks = settings.hooks.SessionStart.flatMap((group) => group.hooks || [])
    .filter((hook) => String(hook.command).includes('gtasks-pending-notice.mjs'));
  assert.equal(hooks.length, 1);
  assert.equal(hooks[0].timeout, 15);
  assert.equal('async' in hooks[0], false);
  assert.match(second, /hook は既に登録済み\(変更なし\)/);
  fs.rmSync(home, { recursive: true, force: true });
});

test('手間削減hook 8本を正しいイベントへ登録しstop-gateは登録しない', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-parity-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
  const names = (event) => settings.hooks[event].flatMap((group) => group.hooks || []).map((hook) => path.basename(String(hook.command).match(/"([^"]+\.mjs)"/)?.[1] || ''));
  assert.deepEqual(['automation-first-reminder.mjs', 'credentials-reminder.mjs'].every((name) => names('UserPromptSubmit').includes(name)), true);
  assert.deepEqual(['pretooluse-headless-background.mjs', 'pretooluse-serial-investigation.mjs', 'pipe-stage-permissions.mjs'].every((name) => names('PreToolUse').includes(name)), true);
  assert.deepEqual(['handoff-quality-gate.mjs', 'handoff-investigation-gate.mjs', 'negative-claim-gate.mjs', 'handoff-detail-guard.mjs', 'url-format-guard.mjs', 'check-e2e-before-stop.mjs'].every((name) => names('Stop').includes(name)), true);
  assert.equal(Object.values(settings.hooks).flatMap((groups) => groups).flatMap((group) => group.hooks || []).some((hook) => /(?:^|[\\/])stop-gate\.mjs/.test(String(hook.command))), false);
  fs.rmSync(home, { recursive: true, force: true });
});

test('手間削減hook 8本は2回実行しても各1本のまま', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'register-hooks-parity-idempotent-'));
  const repo = path.resolve('.');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const env = { ...process.env, ORGIAST_HOME: home, ORGIAST_REPO: repo };
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--hooks-only'], { encoding: 'utf8', env });
  const commands = Object.values(JSON.parse(fs.readFileSync(settingsFile, 'utf8')).hooks).flatMap((groups) => groups).flatMap((group) => group.hooks || []).map((hook) => String(hook.command));
  for (const name of ['automation-first-reminder', 'credentials-reminder', 'pretooluse-headless-background', 'pretooluse-serial-investigation', 'handoff-quality-gate', 'handoff-investigation-gate', 'negative-claim-gate', 'handoff-detail-guard', 'pipe-stage-permissions', 'url-format-guard', 'check-e2e-before-stop']) {
    assert.equal(commands.filter((command) => command.includes(name)).length, 1, `${name} must be unique`);
  }
  fs.rmSync(home, { recursive: true, force: true });
});
