// setup --converge only: official Node MSI + the default user's Ubuntu runtime.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const DIST = 'https://nodejs.org/dist';
const exec = promisify(execFile);
const psQuote = (value) => `'${String(value).replaceAll("'", "''")}'`;
const encoded = (script) => Buffer.from(script, 'utf16le').toString('base64');
const psArgs = (script) => ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded(script)];
const ADMIN = '([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)';
const NVM = 'export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"; if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi;';

function version(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(value).trim());
  if (!match) throw new Error(`Node バージョンを解釈できません: ${String(value).trim().slice(0, 80)}`);
  return match.slice(1).map(Number);
}
export function compareVersions(a, b) {
  const left = version(a), right = version(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
export function targetVersion(current, releases) {
  const installedMajor = version(current)[0];
  const major = installedMajor <= 20 ? 24 : installedMajor;
  const candidates = releases.map((release) => release.version)
    .filter((v) => /^v\d+\.\d+\.\d+$/.test(v) && version(v)[0] === major)
    .sort(compareVersions);
  if (!candidates.length) throw new Error(`Node ${major} 系のリリースが見つかりません`);
  return candidates.at(-1);
}
export function verifySha256(bytes, sums, filename) {
  const entries = String(sums).split(/\r?\n/).map((line) => /^([a-f\d]{64})\s+\*?(.+)$/i.exec(line))
    .filter((match) => match?.[2] === filename);
  if (entries.length !== 1) throw new Error(`SHA256 エントリが一意に見つかりません: ${filename}`);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== entries[0][1].toLowerCase()) throw new Error(`SHA256 不一致: ${filename}`);
  return digest;
}
function readVersion(output) {
  const lines = String(output).trim().split(/\r?\n/);
  const value = lines.findLast((line) => /^v\d+\.\d+\.\d+$/.test(line.trim()));
  version(value);
  return value.trim();
}
const brief = (error) => String(error?.message || error).split(/\r?\n/)[0];

export function windowsInstallCommand(msi, log) {
  // Start-Process joins array elements without quoting them; use one quoted argument string.
  return `/i "${msi}" /qn /norestart /l*v "${log}"`;
}

export function buildFallbackCmd({ msi, digest, target, log, resultLog, node = 'node.exe' }) {
  version(target);
  if (!/^[a-f\d]{64}$/i.test(digest)) throw new Error('invalid digest');
  const install = `$ErrorActionPreference = 'Stop'
$resultLog = ${psQuote(resultLog)}
New-Item -ItemType Directory -Force -Path (Split-Path $resultLog) | Out-Null
try {
  if ((Get-FileHash -LiteralPath ${psQuote(msi)} -Algorithm SHA256).Hash -ne ${psQuote(digest)}) { throw 'SHA256 mismatch' }
  $before = & ${psQuote(node)} -v
  if ($LASTEXITCODE -ne 0) { throw 'node read-back failed' }
  if ([version]($before.Trim() -replace '^v','') -lt [version]${psQuote(target.replace(/^v/, ''))}) {
    $p = Start-Process msiexec.exe -ArgumentList ${psQuote(windowsInstallCommand(msi, log))} -Wait -PassThru
    if ($p.ExitCode -notin @(0,1641,3010)) { throw ('msiexec exit=' + $p.ExitCode) }
  }
  $actual = & ${psQuote(node)} -v
  if ($LASTEXITCODE -ne 0 -or [version]($actual.Trim() -replace '^v','') -lt [version]${psQuote(target.replace(/^v/, ''))}) { throw ('read-back=' + $actual) }
  ('RESULT=OK ' + $actual.Trim()) | Set-Content -LiteralPath $resultLog -Encoding UTF8
} catch {
  ('RESULT=NG ' + $_.Exception.Message) | Set-Content -LiteralPath $resultLog -Encoding UTF8
  exit 1
}
`;
  // Hybrid CMD/PowerShell keeps the command line short and preserves Japanese paths.
  return `@echo off\r
setlocal\r
set "NODE_SECURITY_LAUNCHER=%~f0"\r
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$s=[IO.File]::ReadAllText($env:NODE_SECURITY_LAUNCHER,[Text.Encoding]::UTF8); & ([scriptblock]::Create(($s -split '(?m)^# POWERSHELL\\r?$',2)[1]))"\r
exit /b %errorlevel%\r
# POWERSHELL\r
$ErrorActionPreference = 'Stop'
$payload = '${encoded(install)}'
if (${ADMIN}) {
  & ([scriptblock]::Create([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($payload))))
} else {
  Start-Process powershell.exe -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ' + $payload) -Verb RunAs
}
`;
}

function system(overrides) {
  return {
    platform: process.platform,
    arch: process.arch,
    home: process.env.USERPROFILE || os.homedir(),
    temp: process.env.TEMP || os.tmpdir(),
    account: process.env.USERNAME || os.userInfo().username,
    fs,
    now: Date.now,
    sleep: delay,
    async run(file, args, options = {}) {
      const result = await exec(file, args, { encoding: 'utf8', timeout: 15_000, windowsHide: true, ...options });
      return result.stdout;
    },
    async launch(script) {
      // ShellExecute itself may wait for UAC even without -Wait. Do not await this PowerShell.
      const child = spawn('powershell.exe', psArgs(script), { stdio: 'ignore', windowsHide: true });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.unref();
    },
    async download(url) {
      const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`ダウンロード失敗 HTTP ${response.status}: ${url}`);
      return Buffer.from(await response.arrayBuffer());
    },
    ...overrides,
  };
}

async function windowsRuntime(io, releases) {
  const current = readVersion(await io.run('node.exe', ['-v']));
  const target = targetVersion(current, releases);
  if (compareVersions(current, target) >= 0) return { text: `Windows ${current}`, repaired: false };
  if (io.arch !== 'x64') throw new Error(`Windows ${current}: x64 MSI 非対応 (${io.arch})`);
  const filename = `node-${target}-x64.msi`;
  const sums = await io.download(`${DIST}/${target}/SHASUMS256.txt`);
  const bytes = await io.download(`${DIST}/${target}/${filename}`);
  const digest = verifySha256(bytes, sums, filename);
  const directory = await io.fs.mkdtemp(path.join(io.temp, 'node-runtime-security-'));
  const msi = path.join(directory, filename);
  const log = path.join(directory, 'msiexec.log');
  await io.fs.writeFile(msi, bytes);
  const elevated = (await io.run('powershell.exe', psArgs(ADMIN))).trim().toLowerCase() === 'true';
  if (elevated) {
    // execFile bypasses PowerShell's native argument joining and waits for the installer.
    try {
      await io.run('msiexec.exe', ['/i', msi, '/qn', '/norestart', '/l*v', log], { timeout: 300_000 });
    } catch (error) {
      if (![1641, 3010].includes(error.code)) throw new Error(`Windows ${current}: msiexec exit=${error.code ?? brief(error)}; log=${log}`);
    }
    const actual = readVersion(await io.run('node.exe', ['-v']));
    if (compareVersions(actual, target) < 0) throw new Error(`Windows ${actual}: 更新先 ${target} の read-back 未確認; log=${log}`);
    return { text: `Windows ${actual}`, repaired: true };
  }

  // Prepare the recovery file before UAC, so an interrupted converge also leaves a usable route.
  const desktopRaw = await io.run('powershell.exe', psArgs("[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([Environment]::GetFolderPath('Desktop')))"));
  const desktop = Buffer.from(desktopRaw.trim(), 'base64').toString('utf8');
  if (!desktop) throw new Error('デスクトップの場所を取得できません');
  const account = io.account.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  const launcher = path.join(desktop, `Node更新-${account}.cmd`);
  const resultLog = path.join(io.home, '.claude', 'logs', 'node-update.log');
  await io.fs.mkdir(desktop, { recursive: true });
  await io.fs.writeFile(launcher, buildFallbackCmd({ msi, digest, target, log, resultLog }), 'utf8');
  const deadline = io.now() + 60_000;
  let actual = current;
  try {
    await io.launch(`$ErrorActionPreference = 'Stop'; Start-Process msiexec.exe -ArgumentList ${psQuote(windowsInstallCommand(msi, log))} -Verb RunAs`);
    while (io.now() < deadline) {
      await io.sleep(Math.min(2000, deadline - io.now()));
      try { actual = readVersion(await io.run('node.exe', ['-v'], { timeout: Math.max(1, Math.min(5000, deadline - io.now())) })); }
      catch { continue; } // node.exe may be briefly locked while MSI replaces it.
      if (compareVersions(actual, target) >= 0) {
        await io.fs.rm(launcher, { force: true });
        return { text: `Windows ${actual}`, repaired: true };
      }
    }
  } catch (error) {
    return { notice: true, text: `Windows ${actual}: UAC 起動失敗 (${brief(error)}); ${launcher} をダブルクリック→UAC「はい」。結果: ${resultLog}`, repaired: false };
  }
  return { notice: true, text: `Windows ${actual}: 60秒以内に ${target} の更新を確認できません（UAC 未応答/取消/インストール中）; ${launcher} をダブルクリック→UAC「はい」。結果: ${resultLog}`, repaired: false };
}

async function ubuntuRuntime(io, releases) {
  let distros;
  try { distros = await io.run('wsl.exe', ['--list', '--quiet']); }
  catch (error) { if (error.code === 'ENOENT') return { text: 'WSL なし' }; throw error; }
  if (!distros.replaceAll('\0', '').split(/\r?\n/).some((name) => name.trim() === 'Ubuntu')) return { text: 'WSL Ubuntu なし' };
  const userShell = (script, options) => io.run('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-lc', `${NVM} ${script}`], options);
  const current = readVersion(await userShell('node -v'));
  const target = targetVersion(current, releases);
  if (compareVersions(current, target) >= 0) return { text: `WSL ${current}`, repaired: false };
  const manager = (await userShell('if command -v nvm >/dev/null 2>&1; then echo nvm; else echo nodesource; fi')).trim();
  if (manager === 'nvm') {
    await userShell(`nvm install ${target} && nvm alias default ${target}`, { timeout: 300_000 });
  } else if (manager === 'nodesource') {
    const major = version(target)[0];
    // Run only the package installer as root; nvm and read-back always use the distro's default user.
    await io.run('wsl.exe', ['-d', 'Ubuntu', '-u', 'root', '--', 'bash', '-lc',
      `set -e; setup_file=$(mktemp); trap 'rm -f "$setup_file"' EXIT; curl --fail --silent --show-error --location --max-time 120 https://deb.nodesource.com/setup_${major}.x -o "$setup_file"; bash "$setup_file"; DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs`], { timeout: 300_000 });
  } else throw new Error(`WSL ${current}: パッケージ管理方式を確認できません`);
  const actual = readVersion(await userShell('node -v'));
  if (version(actual)[0] !== version(target)[0] || compareVersions(actual, target) < 0) throw new Error(`WSL ${actual}: 更新先 ${target} の read-back 未確認`);
  return { text: `WSL ${actual}`, repaired: true };
}

export async function convergeNodeRuntimeSecurity(overrides = {}) {
  const io = system(overrides);
  if (io.platform !== 'win32') return { status: 'NOTICE', checked: false, repaired: false, description: 'Windows ホストで実行してください（WSL Ubuntu も Windows 経由で検査）' };
  let releases;
  try {
    releases = JSON.parse(String(await io.download(`${DIST}/index.json`)));
    if (!Array.isArray(releases) || releases.some((release) => !release || typeof release.version !== 'string')) throw new Error('index.json が不正です');
  } catch (error) { return { status: 'NOTICE', checked: false, repaired: false, description: brief(error) }; }
  const outcomes = [];
  for (const [label, operation] of [['Windows', windowsRuntime], ['WSL', ubuntuRuntime]]) {
    try { outcomes.push(await operation(io, releases)); }
    catch (error) { outcomes.push({ notice: true, text: `${label}: ${brief(error)}` }); }
  }
  return { status: outcomes.some((outcome) => outcome.notice) ? 'NOTICE' : 'OK', checked: true,
    repaired: outcomes.some((outcome) => outcome.repaired), description: outcomes.map((outcome) => outcome.text).join(' / ') };
}
