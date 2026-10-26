import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { compareVersions, targetVersion, verifySha256, buildFallbackCmd, convergeNodeRuntimeSecurity } from './setup-node-runtime-security.mjs';

const releases = ['v22.23.4', 'v24.9.0', 'v26.12.1', 'v24.22.1', 'v24.22.0', 'v24.23.0-rc.1'].map((version) => ({ version }));
const bytes = Buffer.from('mock official MSI');
const hash = createHash('sha256').update(bytes).digest('hex');
const psScript = (args) => Buffer.from(args.at(-1), 'base64').toString('utf16le');

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'node-security-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let current = options.current || 'v24.20.0', ubuntu = options.ubuntu;
  let now = 0, launches = 0;
  const calls = [], downloads = [], sleeps = [];
  const desktop = path.join(root, "OneDrive 日本語 O'Brien", 'Desktop');
  const launcher = path.join(desktop, 'Node更新-test user.cmd');
  const io = {
    platform: 'win32', arch: 'x64', home: root, temp: root, account: 'test user', fs,
    wslInstalled: () => true, msiBusy: () => false,
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
    async download(url) {
      downloads.push(url);
      if (options.networkFail || options.failUrl && url.endsWith(options.failUrl)) throw new Error('network unavailable');
      if (url.endsWith('/index.json')) return Buffer.from(options.index ?? JSON.stringify(releases));
      if (url.endsWith('/SHASUMS256.txt')) return Buffer.from(`${options.badSha ? '0'.repeat(64) : hash}  node-${targetVersion(current, releases)}-x64.msi\n`);
      return bytes;
    },
    async run(file, args, opts) {
      calls.push({ file, args, opts });
      if (file === 'node.exe') return current;
      if (file === 'powershell.exe') {
        const script = psScript(args);
        if (script.includes("GetFolderPath('Desktop')")) return Buffer.from(desktop).toString('base64');
        assert.match(script, /IsInRole/);
        return String(options.elevated ?? true);
      }
      if (file === 'msiexec.exe') {
        if (!options.keepOld) current = targetVersion(current, releases);
        if (options.msiCode) throw Object.assign(new Error('installer error'), { code: options.msiCode });
        return '';
      }
      if (file === 'wsl.exe') {
        if (options.wslMissing) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        if (options.wslError) throw new Error('WSL unavailable');
        if (args[0] === '--list') return ubuntu ? 'U\0b\0u\0n\0t\0u\0\r\0\n\0' : 'docker-desktop\r\n';
        const script = args.at(-1);
        if (script.endsWith('node -v')) return ubuntu;
        if (script.includes('echo nodesource')) return options.manager || 'nvm';
        if (options.wslInstallFail) throw new Error('WSL install failed');
        if (!options.wslKeepOld) ubuntu = targetVersion(ubuntu, releases);
        return '';
      }
      throw new Error(`unexpected command ${file}`);
    },
    async launch(script) {
      launches++;
      calls.push({ file: 'launch', script });
      assert.match(await fs.readFile(launcher, 'utf8'), /-Verb RunAs/);
      if (options.launchError) throw new Error('UAC launch failed');
      if (!options.ignoreUac) current = targetVersion(current, releases);
    },
  };
  return { io, root, desktop, launcher, calls, downloads, sleeps, get launches() { return launches; } };
}

test('numeric version ordering, equality, and invalid versions', () => {
  assert.equal(compareVersions('v24.9.9', '24.22.1'), -1);
  assert.equal(compareVersions('v22.23.4', 'v22.23.3'), 1);
  assert.equal(compareVersions('24.22.1', 'v24.22.1'), 0);
  assert.equal(compareVersions('26.0.0', '24.22.1'), 1);
  assert.throws(() => compareVersions('v24.22.1; bad', 'v24.22.1'));
});

test('target keeps each major, upgrades <=20 to 24, ignores prereleases and index order', () => {
  for (const old of ['v18.20.0', 'v20.19.0', 'v24.0.0']) assert.equal(targetVersion(old, releases), 'v24.22.1');
  assert.equal(targetVersion('v22.0.0', releases), 'v22.23.4');
  assert.equal(targetVersion('v26.0.0', releases), 'v26.12.1');
  assert.throws(() => targetVersion('v28.0.0', releases), /見つかりません/);
});

test('SHA256 requires the exact filename and one matching entry', () => {
  const name = 'node-v24.22.1-x64.msi';
  assert.equal(verifySha256(bytes, `${hash.toUpperCase()} *${name}\r\n`, name), hash);
  assert.throws(() => verifySha256(Buffer.from('corrupt'), `${hash}  ${name}`, name), /不一致/);
  assert.throws(() => verifySha256(bytes, `${hash}  ${name}.zip`, name), /見つかりません/);
  assert.throws(() => verifySha256(bytes, `${hash}  ${name}\n${hash}  ${name}`, name), /一意/);
});

test('latest Windows/Ubuntu is one OK result, with no download/install/UAC side effects', async (t) => {
  const f = await fixture(t, { current: 'v24.22.1', ubuntu: 'v22.23.4' });
  const result = await convergeNodeRuntimeSecurity(f.io);
  assert.deepEqual(result, { status: 'OK', checked: true, repaired: false, description: 'Windows v24.22.1 / WSL v22.23.4' });
  assert.equal(f.downloads.length, 1);
  assert.equal(f.calls.some((call) => /powershell|msiexec|launch/.test(call.file)), false);
});

test('elevated MSI installation verifies bytes, uses silent flags and fresh read-back; rerun is idle', async (t) => {
  const f = await fixture(t);
  const result = await convergeNodeRuntimeSecurity(f.io);
  assert.equal(result.status, 'OK');
  assert.equal(result.repaired, true);
  assert.match(result.description, /Windows v24.22.1/);
  const msi = f.calls.find((call) => call.file === 'msiexec.exe');
  assert.deepEqual(msi.args.slice(2, 5), ['/qn', '/norestart', '/l*v']);
  assert.deepEqual(await fs.readFile(msi.args[1]), bytes);
  assert.equal(f.calls.filter((call) => call.file === 'node.exe').length, 2);
  assert.equal(f.launches, 0);
  assert.equal((await convergeNodeRuntimeSecurity(f.io)).repaired, false);
  assert.equal(f.calls.filter((call) => call.file === 'msiexec.exe').length, 1);
});

for (const msiCode of [1641, 3010]) test(`MSI reboot-required exit ${msiCode} still requires read-back`, async (t) => {
  const f = await fixture(t, { msiCode });
  assert.equal((await convergeNodeRuntimeSecurity(f.io)).status, 'OK');
});

for (const options of [{ msiCode: 1603, keepOld: true }, { keepOld: true }]) test(`MSI failure or stale read-back is NOTICE: ${JSON.stringify(options)}`, async (t) => {
  const f = await fixture(t, options);
  const result = await convergeNodeRuntimeSecurity(f.io);
  assert.equal(result.status, 'NOTICE');
  assert.match(result.description, /1603|read-back/);
  assert.equal(result.repaired, false);
});

test('non-elevated launch has RunAs without Wait and polls using the Node timer', async (t) => {
  const f = await fixture(t, { elevated: false });
  const result = await convergeNodeRuntimeSecurity(f.io);
  assert.equal(result.status, 'OK');
  assert.equal(f.launches, 1);
  assert.deepEqual(f.sleeps, [2000]);
  const launch = f.calls.find((call) => call.file === 'launch').script;
  assert.match(launch, /Start-Process msiexec\.exe -ArgumentList.*-Verb RunAs/);
  assert.doesNotMatch(launch, /-Wait/);
  assert.equal(f.calls.some((call) => call.file === 'msiexec.exe'), false);
  await assert.rejects(fs.access(f.launcher));
});

test('ignored UAC stops polling at 60 seconds, leaves a self-elevating launcher and original-user log', async (t) => {
  const f = await fixture(t, { elevated: false, ignoreUac: true });
  const result = await convergeNodeRuntimeSecurity(f.io);
  assert.equal(result.status, 'NOTICE');
  assert.equal(f.sleeps.reduce((sum, value) => sum + value, 0), 60000);
  assert.equal(f.launches, 1);
  assert.match(result.description, /Node更新-test user\.cmd.*ダブルクリック.*node-update\.log/);
  const cmd = await fs.readFile(f.launcher, 'utf8');
  assert.match(cmd, /-Verb RunAs/);
  const payload = Buffer.from(cmd.match(/\$payload = '([^']+)'/)[1], 'base64').toString('utf16le');
  assert.match(payload, /Get-FileHash.*SHA256/);
  assert.match(payload, /RESULT=OK/);
  assert.match(payload, /RESULT=NG/);
  assert.ok(payload.includes(path.join(f.root, '.claude', 'logs', 'node-update.log')));
  assert.match(payload, /-notin @\(0,1641,3010\)/);
  assert.match(payload, /-lt \[version\]'24\.22\.1'/);
});

test('UAC process launch failure leaves the recovery launcher', async (t) => {
  const f = await fixture(t, { elevated: false, launchError: true });
  assert.match((await convergeNodeRuntimeSecurity(f.io)).description, /UAC 起動失敗/);
  await fs.access(f.launcher);
});

for (const options of [{ networkFail: true }, { failUrl: 'SHASUMS256.txt' }, { failUrl: '.msi' }, { badSha: true }, { index: '{}' }]) {
  test(`network/index/hash failure never invokes installer: ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options);
    const result = await convergeNodeRuntimeSecurity(f.io);
    assert.equal(result.status, 'NOTICE');
    assert.equal(f.calls.some((call) => /powershell|msiexec|launch/.test(call.file)), false);
    assert.equal(f.launches, 0);
  });
}

test('nvm updates Ubuntu in its own major/default user and reads back a new login shell', async (t) => {
  const f = await fixture(t, { current: 'v24.22.1', ubuntu: 'v22.23.3' });
  const result = await convergeNodeRuntimeSecurity(f.io);
  assert.equal(result.status, 'OK');
  assert.equal(result.description, 'Windows v24.22.1 / WSL v22.23.4');
  const install = f.calls.find((call) => call.args?.at(-1).includes('nvm install'));
  assert.match(install.args.at(-1), /nvm install v22\.23\.4 && nvm alias default v22\.23\.4/);
  assert.ok(!install.args.includes('root'));
  assert.match(install.args.at(-1), /nvm\.sh/);
  assert.equal(f.calls.filter((call) => call.file === 'wsl.exe' && call.args.at(-1).endsWith('node -v')).length, 2);
});

test('NodeSource upgrades EOL Ubuntu to 24 as root, verifies as default user', async (t) => {
  const f = await fixture(t, { current: 'v24.22.1', ubuntu: 'v20.19.0', manager: 'nodesource' });
  const result = await convergeNodeRuntimeSecurity(f.io);
  assert.equal(result.status, 'OK');
  assert.match(result.description, /WSL v24.22.1/);
  const install = f.calls.find((call) => call.args?.includes('root'));
  assert.match(install.args.at(-1), /set -e;.*curl --fail.*setup_24\.x.*bash "\$setup_file";.*apt-get install -y nodejs/);
  assert.ok(!f.calls.at(-1).args.includes('root'));
});

for (const options of [{ wslInstallFail: true }, { wslKeepOld: true }]) test(`Ubuntu update failure cannot be reported OK: ${JSON.stringify(options)}`, async (t) => {
  const f = await fixture(t, { current: 'v24.22.1', ubuntu: 'v22.23.3', ...options });
  assert.equal((await convergeNodeRuntimeSecurity(f.io)).status, 'NOTICE');
});

test('Windows SHA mismatch does not prevent independent Ubuntu convergence', async (t) => {
  const f = await fixture(t, { badSha: true, ubuntu: 'v22.23.3' });
  const result = await convergeNodeRuntimeSecurity(f.io);
  assert.equal(result.status, 'NOTICE');
  assert.match(result.description, /SHA256 不一致.*WSL v22\.23\.4/);
});

test('absent WSL is OK; failed WSL inspection is NOTICE', async (t) => {
  const absent = await fixture(t, { current: 'v24.22.1', wslMissing: true });
  assert.equal((await convergeNodeRuntimeSecurity(absent.io)).status, 'OK');
  const failed = await fixture(t, { current: 'v24.22.1', wslError: true });
  assert.equal((await convergeNodeRuntimeSecurity(failed.io)).status, 'NOTICE');
});

test('non-Windows and non-x64 do not install an x64 Windows MSI', async (t) => {
  const f = await fixture(t);
  assert.equal((await convergeNodeRuntimeSecurity({ ...f.io, platform: 'linux' })).status, 'NOTICE');
  assert.equal(f.downloads.length, 0);
  assert.equal((await convergeNodeRuntimeSecurity({ ...f.io, arch: 'arm64' })).status, 'NOTICE');
  assert.equal(f.downloads.length, 1);
});

test('fallback handles Japanese, spaces, apostrophes and cmd metacharacters as data', () => {
  const cmd = buildFallbackCmd({ msi: "C:\\Users\\O'Brien & 日本語\\node.msi", log: 'C:\\Temp\\msi.log',
    resultLog: 'C:\\Users\\original\\.claude\\logs\\node-update.log', digest: hash, target: 'v24.22.1' });
  const payload = Buffer.from(cmd.match(/\$payload = '([^']+)'/)[1], 'base64').toString('utf16le');
  assert.match(payload, /O''Brien & 日本語/);
  assert.ok(Math.max(...cmd.split(/\r?\n/).map((line) => line.length)) < 8191);
  assert.match(cmd, /NODE_SECURITY_LAUNCHER=%~f0/);
  assert.match(cmd, /exit \/b %errorlevel%/);
});

test('Windows PowerShell 5.1 parses the launcher and executes its payload with mocked MSI/files/node', async (t) => {
  const powershell = process.platform === 'win32' ? 'powershell.exe'
    : '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
  if (process.platform !== 'win32') {
    try { await fs.access(powershell); } catch { t.skip('Windows PowerShell is unavailable'); return; }
  }
  const cmd = buildFallbackCmd({ msi: "C:\\Temp\\O'Brien 日本語\\node.msi", log: 'C:\\Temp\\msi.log',
    resultLog: 'C:\\Users\\original\\.claude\\logs\\node-update.log', digest: hash, target: 'v24.22.1', node: 'ReadMockNode' });
  const bootstrap = cmd.split(/^# POWERSHELL\r?$/m)[1];
  const payload = cmd.match(/\$payload = '([^']+)'/)[1];
  for (const scenario of ['update', 'reboot', 'latest', 'bad-sha']) {
    const script = `$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$bootstrap = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${Buffer.from(bootstrap, 'utf16le').toString('base64')}'))
$null = [System.Management.Automation.Language.Parser]::ParseInput($bootstrap, [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$script:installed = $${scenario === 'latest'}
function ReadMockNode { $global:LASTEXITCODE = 0; if ($script:installed) { 'v24.22.1' } else { 'v24.20.0' } }
function New-Item { param($ItemType, [switch]$Force, $Path) }
function Get-FileHash { param($LiteralPath, $Algorithm); @{Hash = '${scenario === 'bad-sha' ? '0'.repeat(64) : hash}'} }
function Set-Content { param([Parameter(ValueFromPipeline)]$Value, $LiteralPath, $Encoding); process { [Console]::WriteLine($Value) } }
function Start-Process {
  param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru)
  if ($FilePath -ne 'msiexec.exe' -or -not $Wait -or -not $PassThru) { throw 'unexpected process invocation' }
  $script:installed = $true
  [Console]::WriteLine('MSI_CALLED')
  @{ExitCode = ${scenario === 'reboot' ? 3010 : 0}}
}
& ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${payload}'))))
`;
    const entry = '& ([scriptblock]::Create([Console]::In.ReadToEnd()))';
    const result = spawnSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(entry, 'utf16le').toString('base64')], {
      input: script, encoding: 'utf8', timeout: 30_000, windowsHide: true,
    });
    assert.equal(result.status, scenario === 'bad-sha' ? 1 : 0, scenario + ': ' + result.stdout + result.stderr);
    assert.match(result.stdout, scenario === 'bad-sha' ? /RESULT=NG SHA256 mismatch/ : /RESULT=OK v24\.22\.1/);
    assert.equal(result.stdout.includes('MSI_CALLED'), ['update', 'reboot'].includes(scenario), scenario);
  }
});

test('setup integration emits exactly one runtime result, skips verify and custom manifests', async (t) => {
  // Execute the real setup CLI with only unrelated side-effect modules replaced in an isolated tree.
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-runtime-integration-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'lib'));
  await fs.copyFile(new URL('./setup.mjs', import.meta.url), path.join(root, 'setup.mjs'));
  await fs.copyFile(new URL('./setup-task-hidden-actions.mjs', import.meta.url), path.join(root, 'setup-task-hidden-actions.mjs'));
  const files = {
    'setup-manifest.json': '{"version":1,"items":[]}',
    'lib/playbook-distribution.mjs': 'export const distributePlaybooks = () => 0;',
    'lib/fleet-label.mjs': 'export const resolveFleetLabel = () => "test";',
    'register-fleet-mail.mjs': 'export const fleetHubNeedsConfiguration = () => false;',
    'allow-rules.mjs': 'export const convergeAllowRules = () => false;',
    'mobile-standby.mjs': 'export const convergeMobileStandby = () => ({ok: true, lines: []});',
    'register-hooks.mjs': '',
    'setup-node-runtime-security.mjs': 'export const convergeNodeRuntimeSecurity = async () => ({status: "OK", checked: true, repaired: false, description: "Windows v24.22.1 / WSL v22.23.4"});',
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  const run = (args) => execFileSync(process.execPath, [path.join(root, 'setup.mjs'), '--home', root, '--no-beacon', ...args], { encoding: 'utf8' });
  const output = run(['--converge']);
  assert.equal(output.split('\n').filter(line => line.includes('task-hidden-actions')).length, 1);
  assert.equal(output.split('\n').filter((line) => line.includes('node-runtime-security')).length, 1);
  assert.match(output, /^\[OK \] node-runtime-security - Windows v24\.22\.1 \/ WSL v22\.23\.4$/m);
  assert.equal(JSON.parse(run(['--converge', '--json'])).items.find((item) => item.id === 'node-runtime-security').status, 'OK');
  assert.doesNotMatch(run(['--verify']), /node-runtime-security|task-hidden-actions/);
  assert.doesNotMatch(run(['--converge', '--manifest', path.join(root, 'setup-manifest.json')]), /node-runtime-security|task-hidden-actions/);
});

const lockPath = f => path.join(f.root, '.claude', 'state', 'node-runtime-security.lock');
async function seedLock(f, startedAt) {
  await fs.mkdir(path.dirname(lockPath(f)), { recursive: true });
  await fs.writeFile(lockPath(f), JSON.stringify({ pid: 123, startedAt }));
}
test('held lock skips all downloads, installers and launches', async t => {
  const f = await fixture(t);
  await seedLock(f, 0);
  const result = await convergeNodeRuntimeSecurity(f.io);
  assert.equal(result.status, 'NOTICE'); assert.match(result.description, /他の converge/);
  assert.equal(f.downloads.length, 0); assert.equal(f.calls.length, 0); assert.equal(f.launches, 0);
  await fs.access(lockPath(f));
});
test('stale lock is reacquired and success removes the lock', async t => {
  const f = await fixture(t);
  await seedLock(f, -30 * 60 * 1000);
  assert.equal((await convergeNodeRuntimeSecurity(f.io)).status, 'OK');
  assert.equal(f.calls.filter(c => c.file === 'msiexec.exe').length, 1);
  await assert.rejects(fs.access(lockPath(f)));
});
test('failed read-back cools down for six hours without download or launcher', async t => {
  const f = await fixture(t, { keepOld: true });
  await convergeNodeRuntimeSecurity(f.io);
  await assert.rejects(fs.access(lockPath(f)));
  const before = f.downloads.length;
  const result = await convergeNodeRuntimeSecurity(f.io);
  assert.match(result.description, /前回の更新試行から6時間以内/);
  assert.equal(f.downloads.length, before + 1);
  assert.equal(f.calls.filter(c => c.file === 'msiexec.exe').length, 1); assert.equal(f.launches, 0);
  await assert.rejects(fs.access(f.launcher));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(path.dirname(lockPath(f)), 'node-runtime-security.json'))), { lastAttemptAt: 0, target: 'v24.22.1' });
  f.io.now = () => 6 * 60 * 60 * 1000;
  await convergeNodeRuntimeSecurity(f.io);
  assert.equal(f.calls.filter(c => c.file === 'msiexec.exe').length, 2);
});
test('busy MSI skips update before artifact download', async t => {
  const f = await fixture(t); f.io.msiBusy = () => true;
  assert.match((await convergeNodeRuntimeSecurity(f.io)).description, /Installer が実行中/);
  assert.equal(f.downloads.length, 1); assert.equal(f.launches, 0);
  assert.equal(f.calls.some(c => c.file === 'msiexec.exe'), false);
  await assert.rejects(fs.access(lockPath(f)));
});
test('parallel converge calls execute only one MSI', async t => {
  const f = await fixture(t);
  const results = await Promise.all([convergeNodeRuntimeSecurity(f.io), convergeNodeRuntimeSecurity(f.io)]);
  assert.equal(f.calls.filter(c => c.file === 'msiexec.exe').length, 1);
  assert.equal(results.filter(r => /他の converge/.test(r.description)).length, 1);
});
test('UAC launch retains lock and a failed launch releases it', async t => {
  const f = await fixture(t, { elevated: false, ignoreUac: true });
  await convergeNodeRuntimeSecurity(f.io); await fs.access(lockPath(f));
  const fail = await fixture(t, { elevated: false, launchError: true });
  await convergeNodeRuntimeSecurity(fail.io); await assert.rejects(fs.access(lockPath(fail)));
});
test('registry absence prevents any WSL invocation', async t => {
  const f = await fixture(t); f.io.wslInstalled = () => false;
  assert.match((await convergeNodeRuntimeSecurity(f.io)).description, /WSL なし/);
  assert.equal(f.calls.some(c => c.file === 'wsl.exe'), false);
});

test('parallel stale recovery cannot remove a newly acquired lock', async t => {
  const f = await fixture(t);
  await seedLock(f, -30 * 60 * 1000);
  const results = await Promise.all([convergeNodeRuntimeSecurity(f.io), convergeNodeRuntimeSecurity(f.io)]);
  assert.equal(f.calls.filter(c => c.file === 'msiexec.exe').length, 1);
  assert.equal(results.filter(r => /他の converge/.test(r.description)).length, 1);
  await assert.rejects(fs.access(lockPath(f)));
});
