import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const script = resolve('tools/nightly-bootstrap.ps1');
const powershell = process.platform === 'win32'
  ? 'powershell.exe'
  : '/mnt/c/WINDOWS/System32/WindowsPowerShell/v1.0/powershell.exe';
let root;
let launcherSequence = 0;

function toWindowsPath(path) {
  if (process.platform === 'win32') return path;
  return execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim();
}

function fixture(name) {
  const dir = join(root, name);
  const home = join(dir, 'home');
  const repo = join(dir, 'repo');
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });
  return { dir, home, repo };
}

function runBootstrap(fix, target, args = [], extraEnv = {}, shell, bootstrap = script) {
  const windowsPowerShellDir = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0`;
  const launcher = join(fix.dir, `invoke-bootstrap-${++launcherSequence}.ps1`);
  const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const bootstrapPath = toWindowsPath(bootstrap);
  const targetPath = toWindowsPath(target);
  const extraEnvLines = Object.entries(extraEnv).map(([name, value]) =>
    `$env:${name} = ${psQuote(value)}`);
  const shellArgument = shell === undefined ? '' : ` -Shell ${psQuote(shell)}`;
  writeFileSync(launcher, [
    `Set-Variable -Name HOME -Value ${psQuote(toWindowsPath(fix.home))} -Force`,
    `$env:ORGIAST_NIGHTLY_REPO = ${psQuote(toWindowsPath(fix.repo))}`,
    `$env:PATH = ${psQuote(windowsPowerShellDir)}`,
    "$env:ORGIAST_NIGHTLY_NO_SELF_UPDATE = '1'",
    ...extraEnvLines,
    `& ${psQuote(bootstrapPath)} -Target ${psQuote(targetPath)}${shellArgument} -TargetArguments $args`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n'), 'utf8');
  return spawnSync(powershell, [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', toWindowsPath(launcher), '--', ...args,
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: toWindowsPath(fix.home),
      USERPROFILE: toWindowsPath(fix.home),
      PATH: windowsPowerShellDir,
      ...extraEnv,
    },
  });
}

function runBootstrapAsync(fix, target, args = [], extraEnv = {}) {
  const windowsPowerShellDir = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0`;
  const launcher = join(fix.dir, `invoke-bootstrap-${++launcherSequence}.ps1`);
  const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
  const extraEnvLines = Object.entries(extraEnv).map(([name, value]) =>
    `$env:${name} = ${psQuote(value)}`);
  writeFileSync(launcher, [
    `Set-Variable -Name HOME -Value ${psQuote(toWindowsPath(fix.home))} -Force`,
    `$env:ORGIAST_NIGHTLY_REPO = ${psQuote(toWindowsPath(fix.repo))}`,
    `$env:PATH = ${psQuote(windowsPowerShellDir)}`,
    "$env:ORGIAST_NIGHTLY_NO_SELF_UPDATE = '1'",
    ...extraEnvLines,
    `& ${psQuote(toWindowsPath(script))} -Target ${psQuote(target)} -TargetArguments $args`,
    'exit $LASTEXITCODE',
    '',
  ].join('\r\n'), 'utf8');

  return new Promise((resolveResult) => {
    const child = spawn(powershell, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', toWindowsPath(launcher), '--', ...args,
    ], {
      env: {
        ...process.env,
        HOME: toWindowsPath(fix.home),
        USERPROFILE: toWindowsPath(fix.home),
        PATH: windowsPowerShellDir,
        ...extraEnv,
      },
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolveResult({ status: null, stderr: String(error) }));
    child.on('close', (status) => resolveResult({ status, stderr }));
  });
}

function logText(fix) {
  const logDir = join(fix.home, '.claude', 'logs');
  const logName = readdirSync(logDir).find((name) => /^nightly-bootstrap-\d{4}-\d{2}-\d{2}\.log$/.test(name));
  assert.ok(logName, 'nightly bootstrap log was not created');
  return readFileSync(join(logDir, logName), 'utf8');
}

function allLogText(fix) {
  const logDir = join(fix.home, '.claude', 'logs');
  return readdirSync(logDir)
    .filter((name) => /^nightly-bootstrap-\d{4}-\d{2}-\d{2}(?:\.\d+)?\.log$/.test(name))
    .map((name) => readFileSync(join(logDir, name), 'utf8'))
    .join('\n');
}

const hasPowerShell = (() => {
  const probe = spawnSync(powershell, ['-NoProfile', '-Command', 'exit 0']);
  return !probe.error && probe.status === 0;
})();

const windowsPwshDir = String.raw`C:\Program Files\PowerShell\7`;
const hasPwsh = hasPowerShell && (() => {
  const probe = spawnSync(powershell, [
    '-NoProfile', '-Command',
    `if (Test-Path -LiteralPath '${windowsPwshDir}\\pwsh.exe') { exit 0 } else { exit 1 }`,
  ]);
  return !probe.error && probe.status === 0;
})();

before(() => {
  root = mkdtempSync(join(dirname(script), '.nightly-bootstrap-test-'));
});

test('does not self-update a copy outside the operational install path', { skip: !hasPowerShell }, () => {
  const fix = fixture('self-update-guard');
  const copy = join(fix.dir, 'arbitrary', 'nightly-bootstrap.ps1');
  const repoBootstrap = join(fix.repo, 'tools', 'nightly-bootstrap.ps1');
  const target = join(fix.dir, 'target.ps1');
  mkdirSync(dirname(copy), { recursive: true });
  mkdirSync(dirname(repoBootstrap), { recursive: true });
  writeFileSync(copy, readFileSync(script));
  writeFileSync(repoBootstrap, 'different repository version\r\n', 'utf8');
  writeFileSync(target, 'exit 0\r\n', 'utf8');
  const beforeBytes = readFileSync(copy);

  const result = runBootstrap(fix, target, [], {
    ORGIAST_NIGHTLY_NO_SELF_UPDATE: '0',
  }, undefined, copy);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(copy), beforeBytes, 'non-operational copy was modified');
  assert.match(logText(fix), /skip:自己更新\(運用の設置先でないため\)/);
});

test('self-updates the operational copy when PSModulePath is empty', { skip: !hasPowerShell }, () => {
  const fix = fixture('self-update-without-module-autoload');
  const installed = join(fix.home, '.claude', 'tools', 'nightly-bootstrap.ps1');
  const repoBootstrap = join(fix.repo, 'tools', 'nightly-bootstrap.ps1');
  const target = join(fix.dir, 'target.ps1');
  const installedBytes = readFileSync(script);
  const repoBytes = Buffer.concat([installedBytes, Buffer.from('\r\n# repository version\r\n', 'utf8')]);
  mkdirSync(dirname(installed), { recursive: true });
  mkdirSync(dirname(repoBootstrap), { recursive: true });
  writeFileSync(installed, installedBytes);
  writeFileSync(repoBootstrap, repoBytes);
  writeFileSync(target, 'exit 0\r\n', 'utf8');

  const result = runBootstrap(fix, target, [], {
    ORGIAST_NIGHTLY_NO_SELF_UPDATE: '0',
    PSModulePath: '',
  }, undefined, installed);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(installed), repoBytes, 'operational copy was not updated');
  const log = logText(fix);
  assert.match(log, /ok:自己更新\(次回から新版\)/);
  assert.doesNotMatch(log, /warn:.*Get-FileHash/);
});

after(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

test('script is UTF-8 with BOM', () => {
  assert.deepEqual([...readFileSync(script).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
});

test('heartbeat is fail-open and runs before target extension dispatch', () => {
  const source = readFileSync(script, 'utf8');
  const heartbeat = source.indexOf("--job nightly-bootstrap --startedAt");
  const dispatch = source.indexOf("$extension = [IO.Path]::GetExtension($targetPath)");
  assert.ok(heartbeat > 0 && heartbeat < dispatch);
  assert.match(source.slice(source.lastIndexOf('try {', heartbeat), dispatch), /catch \{ \}/);
});

test('missing target exits 1 and writes readable Japanese log', { skip: !hasPowerShell }, () => {
  const fix = fixture('missing');
  const result = runBootstrap(fix, join(fix.dir, 'missing.ps1'));
  assert.equal(result.status, 1, result.stderr);
  const log = logText(fix);
  assert.match(log, /対象が見つからない/);
  assert.match(log, /gitが見つからない/);
  assert.doesNotMatch(log, /�/);
});

test('does not delete a non-repository directory with contents', { skip: !hasPowerShell }, () => {
  const fix = fixture('non-repository');
  const sentinel = join(fix.repo, 'keep.txt');
  writeFileSync(sentinel, 'keep', 'utf8');
  const result = runBootstrap(fix, join(fix.dir, 'missing.ps1'), [], {
    PATH: String.raw`C:\Program Files\Git\cmd;C:\Windows\System32\WindowsPowerShell\v1.0`,
  });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(sentinel), true, 'existing directory contents were deleted');
  assert.match(logText(fix), /リポではないディレクトリが既にある/);
});

test('propagates PowerShell target exit code 7', { skip: !hasPowerShell }, () => {
  const fix = fixture('exit-code');
  const target = join(fix.dir, 'exit-seven.ps1');
  writeFileSync(target, 'exit 7\r\n', 'utf8');
  const result = runBootstrap(fix, target);
  assert.equal(result.status, 7, result.stderr);
  assert.match(logText(fix), /ok:exit-seven\.ps1 終了コード=7/);
});

test('forwards all target arguments and discards leading separator', { skip: !hasPowerShell }, () => {
  const fix = fixture('arguments');
  const target = join(fix.dir, 'capture.ps1');
  const output = join(fix.dir, 'arguments.txt');
  writeFileSync(target, [
    'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Values)',
    '[IO.File]::WriteAllLines($env:CAPTURE_PATH, $Values, (New-Object Text.UTF8Encoding($false)))',
    'exit 0',
    '',
  ].join('\r\n'), 'utf8');
  const result = runBootstrap(fix, target, ['alpha', '日本語', '--flag'], {
    CAPTURE_PATH: toWindowsPath(output),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(output, 'utf8').trim().split(/\r?\n/), ['alpha', '日本語', '--flag']);
});

test('-Shell pwsh runs a PowerShell target in Core', { skip: !hasPwsh }, () => {
  const fix = fixture('shell-pwsh');
  const target = join(fix.dir, 'edition.ps1');
  const output = join(fix.dir, 'edition.txt');
  writeFileSync(target, '[IO.File]::WriteAllText($env:CAPTURE_PATH, $PSVersionTable.PSEdition)\r\n', 'utf8');
  const result = runBootstrap(fix, target, [], {
    CAPTURE_PATH: toWindowsPath(output),
    PATH: `${windowsPwshDir};C:\\Windows\\System32\\WindowsPowerShell\\v1.0`,
  }, 'pwsh');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'Core');
});

test('omitting -Shell runs a PowerShell target in Desktop', { skip: !hasPowerShell }, () => {
  const fix = fixture('shell-default');
  const target = join(fix.dir, 'edition.ps1');
  const output = join(fix.dir, 'edition.txt');
  writeFileSync(target, '[IO.File]::WriteAllText($env:CAPTURE_PATH, $PSVersionTable.PSEdition)\r\n', 'utf8');
  const result = runBootstrap(fix, target, [], { CAPTURE_PATH: toWindowsPath(output) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(output, 'utf8'), 'Desktop');
});

test('-Shell bogus exits 1 and logs the unknown value', { skip: !hasPowerShell }, () => {
  const fix = fixture('shell-bogus');
  const target = join(fix.dir, 'target.ps1');
  writeFileSync(target, 'exit 0\r\n', 'utf8');
  const result = runBootstrap(fix, target, [], {}, 'bogus');
  assert.equal(result.status, 1, result.stderr);
  assert.match(logText(fix), /未知の-Shell bogus/);
});

test('-Shell is not forwarded to the PowerShell target', { skip: !hasPwsh }, () => {
  const fix = fixture('shell-not-forwarded');
  const target = join(fix.dir, 'capture.ps1');
  const output = join(fix.dir, 'arguments.txt');
  writeFileSync(target, [
    'param([Parameter(ValueFromRemainingArguments=$true)][string[]]$Values)',
    '[IO.File]::WriteAllLines($env:CAPTURE_PATH, $Values, (New-Object Text.UTF8Encoding($false)))',
    '',
  ].join('\r\n'), 'utf8');
  const result = runBootstrap(fix, target, ['alpha'], {
    CAPTURE_PATH: toWindowsPath(output),
    PATH: `${windowsPwshDir};C:\\Windows\\System32\\WindowsPowerShell\\v1.0`,
  }, 'pwsh');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(output, 'utf8').trim().split(/\r?\n/), ['alpha']);
});

test('six concurrent runs retain every start and target-execution log line', { skip: !hasPowerShell }, async () => {
  const fix = fixture('concurrent-logging');
  const target = join(fix.repo, 'tools', 'target.ps1');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'Start-Sleep -Milliseconds 100\r\nexit 0\r\n', 'utf8');

  const results = await Promise.all(Array.from({ length: 6 }, () =>
    runBootstrapAsync(fix, String.raw`tools\target.ps1`)));
  for (const result of results) assert.equal(result.status, 0, result.stderr);

  const log = allLogText(fix);
  assert.equal((log.match(/nightly-bootstrap \/ ok:開始/g) || []).length, 6, log);
  assert.equal((log.match(/対象実行 \/ ok:target\.ps1 終了コード=0/g) || []).length, 6, log);
  assert.doesNotMatch(log, /対象が見つからない/);
});

test('mutex timeout logs a warning and continues with the existing target', { skip: !hasPowerShell }, async () => {
  const fix = fixture('mutex-timeout');
  const target = join(fix.repo, 'tools', 'target.ps1');
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, 'exit 0\r\n', 'utf8');

  const holder = runBootstrapAsync(fix, String.raw`tools\target.ps1`, [], {
    ORGIAST_NIGHTLY_MUTEX_HOLD_MS: '2000',
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const contender = await runBootstrapAsync(fix, String.raw`tools\target.ps1`, [], {
    ORGIAST_NIGHTLY_MUTEX_TIMEOUT_MS: '50',
  });
  assert.equal(contender.status, 0, contender.stderr);
  await holder;
  assert.match(allLogText(fix), /warn:他のタスクが同期中のためタイムアウト。既存版で続行/);
});
