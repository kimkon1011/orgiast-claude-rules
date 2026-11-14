import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const hook = fileURLToPath(new URL('./unattended-elevation-gate.mjs', import.meta.url));

function run(input, headless) {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  if (headless) {
    env.CLAUDE_HEADLESS = '1';
  } else {
    delete env.CLAUDE_HEADLESS;
    delete env.ORGIAST_HEADLESS_JOB;
  }
  return spawnSync(process.execPath, [hook], { input, encoding: 'utf8', env });
}

test('非ヘッドレスの通常 Bash は許可する', () => {
  const result = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'echo ok' } }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('winget install (--scope user 付き) は許可する', () => {
  const result = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'winget install --id SomeApp -e --scope user' } }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('ヘッドレスの winget install は deny する', () => {
  const result = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'winget install --id Google.GoogleDrive -e --silent' } }), true);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /winget install/u);
});

test('ヘッドレスの winget upgrade は deny する', () => {
  const result = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'winget upgrade --all' } }), true);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /winget install/u);
});

test('ヘッドレスの msiexec /i は deny する', () => {
  const result = run(JSON.stringify({ tool_name: 'PowerShell', tool_input: { script: 'msiexec /i "C:\\path\\to\\installer.msi" /quiet' } }), true);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /msiexec/u);
});

test('ヘッドレスの Start-Process -Verb RunAs は deny する', () => {
  const result = run(JSON.stringify({ tool_name: 'PowerShell', tool_input: { command: 'Start-Process -FilePath "setup.exe" -Verb RunAs' } }), true);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /RunAs/u);
});

test('ヘッドレスの choco install は deny する', () => {
  const result = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'choco install googlechrome -y' } }), true);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /choco install/u);
});

test('ヘッドレスの Setup*.exe 直接実行は deny する', () => {
  const result = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: './Setup-v2.0.1.exe --silent' } }), true);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /Setup\/Installer/u);
});

test('ヘッドレスの Installer*.exe 直接実行は deny する', () => {
  const result = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: './GoogleDriveInstaller.exe --silent' } }), true);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /Setup\/Installer/u);
});

test('対話セッションの winget install は warn のみ（stdout は空）', () => {
  const result = run(JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'winget install --id Google.GoogleDrive -e --silent' } }));
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /WARN/u);
});

test('Bash 以外のツールは何もしない', () => {
  const result = run(JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/test' } }), true);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('壊れた JSON でも exit 0', () => {
  const result = run('{broken', '1');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

// hasUacPattern のユニットテスト
const { hasUacPattern } = await import('./unattended-elevation-gate.mjs');
test('hasUacPattern は winget install --scope user を null と判定', () => {
  assert.equal(hasUacPattern('winget install --id SomeApp -e --scope user'), null);
});
test('hasUacPattern は通常コマンドを null と判定', () => {
  assert.equal(hasUacPattern('echo hello'), null);
  assert.equal(hasUacPattern('ls -la'), null);
  assert.equal(hasUacPattern(''), null);
  assert.equal(hasUacPattern(null), null);
});