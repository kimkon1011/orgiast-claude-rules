#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';

const REPO = 'google-gemini/gemini-api-cli';
const DAY_MS = 24 * 60 * 60 * 1000;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const bundledSkill = path.join(path.dirname(scriptDir), 'skills', 'gemini-api-cli', 'SKILL.md');

export function assetName(platform, arch) {
  const osName = { win32: 'Windows', linux: 'Linux', darwin: 'Darwin' }[platform];
  const cpu = { x64: 'x86_64', arm64: 'arm64' }[arch];
  if (!osName || !cpu) throw new Error(`Unsupported platform: ${platform}/${arch}`);
  return `gemini-api_${osName}_${cpu}.${platform === 'win32' ? 'zip' : 'tar.gz'}`;
}

export function appendPath(current, installDir, platform = process.platform) {
  const separator = platform === 'win32' ? ';' : ':';
  const parts = String(current || '').split(separator).filter(Boolean);
  const normalize = value => platform === 'win32'
    ? path.win32.normalize(value).replace(/[\\/]+$/, '').toLowerCase()
    : path.posix.normalize(value).replace(/\/+$/, '');
  if (!parts.some(value => normalize(value) === normalize(installDir))) parts.push(installDir);
  return parts.join(separator);
}

function parseEnvKey(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?GEMINI_API_KEY\s*=\s*(.*)\s*$/);
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    return value;
  }
  return '';
}

function parseWhoami(text) {
  try {
    const value = JSON.parse(String(text || '').trim());
    const credentials = value?.credentials;
    if (credentials && typeof credentials === 'object') {
      for (const name of ['api-key', 'access-token']) {
        const source = credentials[name]?.source;
        if (typeof source === 'string' && source && source !== 'unset') {
          return { source, stored: /keyring|keychain|credential manager|credential_manager/i.test(source) };
        }
      }
    }
    const findSource = item => {
      if (!item || typeof item !== 'object') return '';
      for (const key of ['source', 'credential_source', 'api_key_source']) {
        if (typeof item[key] === 'string') return item[key];
      }
      for (const nested of Object.values(item)) {
        const found = findSource(nested);
        if (found) return found;
      }
      return '';
    };
    const source = findSource(value);
    return { source: String(source), stored: /keyring|keychain|credential manager|credential_manager/i.test(String(source)) };
  } catch { return { source: '', stored: false }; }
}

function redact(value, key) {
  let text = String(value?.message || value || 'unknown error');
  if (key) text = text.split(key).join('***');
  return text.replace(/AIza[0-9A-Za-z_-]{20,}/g, '***');
}

function checksumFor(text, name) {
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.trim().match(/^([a-fA-F0-9]{64})\s+\*?(.+)$/);
    if (match && path.basename(match[2].trim()) === name) return match[1].toLowerCase();
  }
  throw new Error(`Checksum entry missing for ${name}`);
}

function findFile(root, wanted, readdir, stat, join = path.join) {
  for (const entry of readdir(root)) {
    const full = join(root, entry);
    if (stat(full).isDirectory()) {
      const found = findFile(full, wanted, readdir, stat, join);
      if (found) return found;
    } else if (entry === wanted) return full;
  }
  return '';
}

export async function installGeminiApiCli({
  home = process.env.ORGIAST_HOME || os.homedir(), platform = process.platform, arch = process.arch,
  env = process.env, spawnImpl = spawnSync, fetchImpl = globalThis.fetch, now = () => new Date(), dryRun = false,
  liveCheck = false, exists = fs.existsSync, read = file => fs.readFileSync(file, 'utf8'),
  readBuffer = file => fs.readFileSync(file), write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); },
  mkdir = dir => fs.mkdirSync(dir, { recursive: true }), copy = (from, to) => fs.copyFileSync(from, to),
  rename = (from, to) => fs.renameSync(from, to), rm = target => fs.rmSync(target, { recursive: true, force: true }),
  chmod = (file, mode) => fs.chmodSync(file, mode), readdir = dir => fs.readdirSync(dir), stat = file => fs.statSync(file),
  mkdtemp = prefix => fs.mkdtempSync(prefix), log = console.log,
} = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const markerFile = p.join(home, '.claude', '.gemini-api-cli-installed.json');
  const skillFile = p.join(home, '.claude', 'skills', 'gemini-api-cli', 'SKILL.md');
  const installDir = platform === 'win32' ? p.join(env.LOCALAPPDATA || p.join(home, 'AppData', 'Local'), 'Programs', 'gemini-api') : p.join(home, '.local', 'bin');
  const binPath = p.join(installDir, platform === 'win32' ? 'gemini-api.exe' : 'gemini-api');
  const plan = [`fetch latest release metadata for ${REPO}`, `verify checksums.txt and install ${assetName(platform, arch)} to ${binPath}`, `add ${installDir} to PATH without reordering existing entries`, `store ~/.gemini/.env key in the OS keychain without logging it`, 'run version and generate ping --dry-run', `ensure ${skillFile}`, `write ${markerFile}`];
  if (dryRun) return { dryRun: true, plan, exitCode: 0 };

  let previous = null;
  try { previous = JSON.parse(read(markerFile)); } catch { /* first install */ }
  const currentTime = now();
  if (previous?.checkedAt && currentTime - new Date(previous.checkedAt) < DAY_MS) {
    return { ...previous, skipped: 'checked-within-24h', exitCode: previous.ok ? 0 : 1 };
  }

  const errors = [];
  let version = previous?.version || '', onPath = false, keyStored = false, keySource = '', skill = false;
  let dryRunResult = { ok: false, exitCode: null }, liveCheckResult = { requested: liveCheck, ok: null, exitCode: null };
  let secret = '';
  const safeError = error => redact(error, secret);
  const childEnv = () => { const value = { ...env }; delete value.GEMINI_API_KEY; return value; };
  const invoke = (exe, args, options = {}) => spawnImpl(exe, args, { encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(), ...options });
  const ok = result => result && !result.error && result.status === 0;
  const requireOk = (result, label) => {
    if (ok(result)) return result;
    throw new Error(`${label}: ${safeError(result?.error || result?.stderr || `exit ${result?.status}`)}`);
  };
  const download = async url => {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'orgiast-setup' };
    if (env.GH_TOKEN) headers.Authorization = `Bearer ${env.GH_TOKEN}`;
    const response = await fetchImpl(url, { headers });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${new URL(url).pathname}`);
    return Buffer.from(await response.arrayBuffer());
  };

  let tempDir = '';
  try {
    const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'orgiast-setup' };
    if (env.GH_TOKEN) headers.Authorization = `Bearer ${env.GH_TOKEN}`;
    const releaseResponse = await fetchImpl(`https://api.github.com/repos/${REPO}/releases/latest`, { headers });
    if (!releaseResponse.ok) throw new Error(`GitHub release API returned ${releaseResponse.status}`);
    const release = await releaseResponse.json();
    version = String(release.tag_name || '').replace(/^v/, '');
    const wanted = assetName(platform, arch);
    const asset = release.assets?.find(value => value.name === wanted);
    const checksums = release.assets?.find(value => value.name === 'checksums.txt');
    if (!asset || !checksums || !version) throw new Error(`Release assets incomplete for ${wanted}`);

    if (!(previous?.version === version && exists(binPath))) {
      const [archive, checksumData] = await Promise.all([download(asset.browser_download_url), download(checksums.browser_download_url)]);
      const expected = checksumFor(checksumData.toString('utf8'), wanted);
      const actual = crypto.createHash('sha256').update(archive).digest('hex');
      if (actual !== expected) throw new Error(`Checksum mismatch for ${wanted}`);
      tempDir = mkdtemp(p.join(os.tmpdir(), 'gemini-api-'));
      const archiveFile = p.join(tempDir, wanted);
      write(archiveFile, archive);
      const extractDir = p.join(tempDir, 'extract'); mkdir(extractDir);
      requireOk(invoke(platform === 'win32' ? 'tar.exe' : 'tar', ['-xf', archiveFile, '-C', extractDir]), 'archive extraction');
      const extracted = findFile(extractDir, platform === 'win32' ? 'gemini-api.exe' : 'gemini-api', readdir, stat, p.join);
      if (!extracted) throw new Error('Archive did not contain the gemini-api binary');
      mkdir(installDir);
      const staged = `${binPath}.new`;
      copy(extracted, staged);
      if (platform !== 'win32') chmod(staged, 0o755);
      if (exists(binPath)) rm(binPath);
      rename(staged, binPath);
    }
  } catch (error) { errors.push(`install: ${safeError(error)}`); }
  finally { if (tempDir) { try { rm(tempDir); } catch { /* best effort */ } } }

  try {
    if (platform === 'win32') {
      const getPath = invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"]);
      requireOk(getPath, 'read user PATH');
      const before = String(getPath.stdout || '').trim();
      const after = appendPath(before, installDir, platform);
      if (after !== before) {
        const script = "$p=[Console]::In.ReadToEnd();[Environment]::SetEnvironmentVariable('Path',$p,'User')";
        requireOk(invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { input: after, stdio: ['pipe', 'pipe', 'pipe'] }), 'write user PATH');
      }
      const verify = requireOk(invoke('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "[Environment]::GetEnvironmentVariable('Path','User')"]), 'read back user PATH');
      onPath = appendPath(String(verify.stdout || '').trim(), installDir, platform) === String(verify.stdout || '').trim();
      env.Path = appendPath(env.Path || env.PATH || '', installDir, platform);
      env.PATH = env.Path;
    } else {
      env.PATH = appendPath(env.PATH || '', installDir, platform);
      onPath = env.PATH.split(':').includes(installDir);
    }
  } catch (error) { errors.push(`path: ${safeError(error)}`); }

  try {
    const before = invoke(binPath, ['whoami', '-o', 'json']);
    let identity = ok(before) ? parseWhoami(before.stdout) : { source: '', stored: false };
    keyStored = identity.stored; keySource = identity.source;
    const envFile = p.join(home, '.gemini', '.env');
    secret = exists(envFile) ? parseEnvKey(read(envFile)) : '';
    if (!keyStored && secret) {
      const help = requireOk(invoke(binPath, ['configure', '--help']), 'inspect configure flags');
      const args = ['configure', '--api-key', secret];
      if (/--no-interactive\b/.test(`${help.stdout || ''}\n${help.stderr || ''}`)) args.push('--no-interactive');
      requireOk(invoke(binPath, args), 'configure keychain');
      identity = parseWhoami(requireOk(invoke(binPath, ['whoami', '-o', 'json']), 'read back credential').stdout);
      keyStored = identity.stored; keySource = identity.source;
      if (!keyStored) throw new Error('Credential read-back did not report the OS keychain');
    }
  } catch (error) { errors.push(`auth: ${safeError(error)}`); }

  try {
    requireOk(invoke(binPath, ['version']), 'version check');
    const result = invoke(binPath, ['generate', 'ping', '--dry-run']);
    dryRunResult = { ok: ok(result), exitCode: result?.status ?? 1 };
    requireOk(result, 'offline dry-run');
  } catch (error) { errors.push(`verify: ${safeError(error)}`); }

  if (liveCheck) {
    try {
      const result = invoke(binPath, ['generate', '1+1の答えを数字だけで', '--stream=false', '-o', 'json']);
      let status = '';
      try { status = JSON.parse(result.stdout).status || ''; } catch { /* status remains empty */ }
      liveCheckResult = { requested: true, ok: ok(result), status, exitCode: result?.status ?? 1 };
      requireOk(result, 'live check');
    } catch (error) { errors.push(`liveCheck: ${safeError(error)}`); }
  }

  try {
    if (!exists(skillFile) && exists(bundledSkill)) { mkdir(p.dirname(skillFile)); copy(bundledSkill, skillFile); }
    skill = exists(skillFile);
  } catch (error) { errors.push(`skill: ${safeError(error)}`); }

  const stamp = currentTime.toISOString();
  const marker = { ok: exists(binPath) && dryRunResult.ok && skill, version, binPath, onPath, keyStored, keySource, skill, dryRun: dryRunResult, liveCheck: liveCheckResult, at: stamp, checkedAt: stamp, errors: errors.map(value => redact(value, secret)) };
  write(markerFile, JSON.stringify(marker, null, 2) + '\n');
  log(`gemini-api CLI setup: ${marker.ok ? 'ok' : 'failed'} (${version || 'unknown'})`);
  return { ...marker, exitCode: marker.ok ? 0 : 1 };
}

export async function main(argv = process.argv.slice(2)) {
  const result = await installGeminiApiCli({ dryRun: argv.includes('--dry-run'), liveCheck: argv.includes('--live-check'), log: argv.includes('--json') ? () => {} : console.log });
  console.log(JSON.stringify(result, null, 2));
  return result.exitCode;
}

if (isEntry(import.meta.url)) {
  try { process.exitCode = await main(); }
  catch (error) { console.error(redact(error)); process.exitCode = 1; }
}
