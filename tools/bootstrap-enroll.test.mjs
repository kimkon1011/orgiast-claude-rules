import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const toolsDir = path.dirname(fileURLToPath(import.meta.url));
const script = (name) => path.join(toolsDir, name);
function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-enroll-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.mkdirSync(path.join(home, 'orgiast-claude-rules', '.git'), { recursive: true });
  return { home, file: path.join(home, '.claude', 'enroll.env'), token: crypto.randomBytes(24).toString('hex') };
}

test('install retains UTF-8 BOM; both bootstraps stay ASCII and at most 30 lines', () => {
  assert.deepEqual([...fs.readFileSync(script('install-orgiast.ps1')).subarray(0, 3)], [239, 187, 191]);
  for (const name of ['bootstrap.ps1', 'bootstrap.sh']) {
    const bytes = fs.readFileSync(script(name));
    assert.equal([...bytes].filter((b) => b > 127).length, 0, name);
    assert.ok(bytes.toString().trimEnd().split('\n').length <= 30, name);
  }
});

test('bootstrap.sh: syntax and real fresh/upgrade execution stores token without logging secrets', { skip: process.platform === 'win32' }, (t) => {
  assert.equal(spawnSync('bash', ['-n', script('bootstrap.sh')]).status, 0);
  const f = fixture(t);
  const bin = path.join(f.home, 'bin');
  fs.mkdirSync(bin);
  for (const name of ['node', 'npm', 'codex', 'git']) fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  for (const useArgument of [false, true]) {
    const token = useArgument ? crypto.randomBytes(24).toString('hex') : f.token;
    const r = spawnSync('sh', [script('bootstrap.sh'), ...(useArgument ? ['--enroll-token', token] : [])], {
      encoding: 'utf8', env: { ...process.env, ORGIAST_HOME: f.home, ORGIAST_ENROLL_TOKEN: f.token, PATH: `${bin}:${process.env.PATH}` },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readFileSync(f.file, 'utf8').trim() === `ORGIAST_ENROLL_TOKEN=${token}`);
    assert.equal(fs.statSync(f.file).mode & 0o777, 0o600);
    assert.match(r.stdout, /ORGIAST-BOOTSTRAP-COMPLETE/);
    assert.ok(!(r.stdout + r.stderr).includes(token), 'token must not be logged');
  }
  const missing = spawnSync('sh', [script('bootstrap.sh'), '--enroll-token'], { encoding: 'utf8' });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /requires a value/);
});

test('PowerShell 5.1: ParseFile zero errors; bootstrap and installer enrollment overwrite without logging secrets', { skip: process.platform !== 'win32' }, (t) => {
  const f = fixture(t);
  const wrapper = path.join(f.home, 'test-entry.ps1');
  // Execute the complete bootstrap with commands stubbed. For the large installer,
  // execute its actual parsed parameter/enrollment statements, avoiding installation side effects.
  fs.writeFileSync(wrapper, `
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSVersion.Major -ne 5) { throw 'Windows PowerShell 5.1 required' }
foreach ($name in @('bootstrap.ps1', 'install-orgiast.ps1')) {
  $sourcePath = Join-Path $env:TEST_TOOLS $name
  $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($sourcePath, [ref]$null, [ref]$errors)
  if ($errors.Count -gt 0) { throw 'ParseFile failed' }
  if ($name -eq 'install-orgiast.ps1') {
    $enroll = @($ast.EndBlock.Statements | Where-Object { $_.Extent.Text.StartsWith('if ($EnrollToken)') })
    if ($enroll.Count -ne 1) { throw 'enrollment statement missing or ambiguous' }
    $body = $ast.ParamBlock.Extent.Text + '\n$HOMEDIR = $env:ORGIAST_HOME\n' + $enroll[0].Extent.Text
    $installEnrollment = [scriptblock]::Create($body)
    & $installEnrollment
    $value = [IO.File]::ReadAllText((Join-Path $env:ORGIAST_HOME '.claude/enroll.env')).Trim()
    if ($value -ne ('ORGIAST_ENROLL_TOKEN=' + $env:ORGIAST_ENROLL_TOKEN)) { throw 'installer environment enrollment failed' }
    & $installEnrollment -EnrollToken $env:TEST_ARGUMENT_TOKEN
    $value = [IO.File]::ReadAllText((Join-Path $env:ORGIAST_HOME '.claude/enroll.env')).Trim()
    if ($value -ne ('ORGIAST_ENROLL_TOKEN=' + $env:TEST_ARGUMENT_TOKEN)) { throw 'installer argument overwrite failed' }
  }
}
function git { }
function claude { }
function codex { }
function node {
  $value = [IO.File]::ReadAllText((Join-Path $env:ORGIAST_HOME '.claude/enroll.env')).Trim()
  if ($value -ne ('ORGIAST_ENROLL_TOKEN=' + $env:TEST_EXPECTED_TOKEN)) { throw 'bootstrap did not save token before converge' }
}
$entry = Join-Path $env:TEST_TOOLS 'bootstrap.ps1'
Remove-Item (Join-Path $env:ORGIAST_HOME '.claude/enroll.env')
$env:TEST_EXPECTED_TOKEN = $env:ORGIAST_ENROLL_TOKEN
& $entry
$env:TEST_EXPECTED_TOKEN = $env:TEST_ARGUMENT_TOKEN
& $entry -EnrollToken $env:TEST_ARGUMENT_TOKEN
`);
  const argumentToken = crypto.randomBytes(24).toString('hex');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', wrapper], {
    encoding: 'utf8', timeout: 30000,
    env: { ...process.env, ORGIAST_HOME: f.home, ORGIAST_ENROLL_TOKEN: f.token, TEST_TOOLS: toolsDir, TEST_ARGUMENT_TOKEN: argumentToken },
  });
  // Do not print PowerShell error source extents, which can contain expanded data.
  assert.equal(r.status, 0, 'PS5.1 parser/enrollment execution failed');
  assert.equal((r.stdout.match(/ORGIAST-BOOTSTRAP-COMPLETE/g) || []).length, 2);
  for (const token of [f.token, argumentToken]) assert.ok(!(r.stdout + r.stderr).includes(token), 'token must not be logged');
  assert.ok(fs.readFileSync(f.file, 'utf8').replace(/^\uFEFF/, '').trim() === `ORGIAST_ENROLL_TOKEN=${argumentToken}`);
});
