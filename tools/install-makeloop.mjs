#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';
import { cmdQuote, discoverWsl } from './lib/quota-sweep-host.mjs';

export const PLUGIN = 'makeloop@makeloop';
// `claude plugin list` は非TTYの子プロセスから応答が返らない（2026-10-21 kim-PC 実測: cmd.exe 経由で ETIMEDOUT）。
// 読戻しは CLI ではなく ~/.claude/plugins/installed_plugins.json の plugins["makeloop@makeloop"] を見る。
export function installedPlugins(text) {
  try { const parsed = JSON.parse(text); return parsed?.plugins && Object.hasOwn(parsed.plugins, PLUGIN) ? parsed.plugins[PLUGIN] : null; } catch { return null; }
}

export function installMakeloop({ home = process.env.ORGIAST_HOME || os.homedir(), platform = process.platform, spawnImpl = spawnSync,
  exists = fs.existsSync, read = file => fs.readFileSync(file, 'utf8'), write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); },
  wsl, dryRun = false, log = console.log } = {}) {
  const p = platform === 'win32' ? path.win32 : path.posix;
  const claudeDir = p.join(home, '.claude'), markerFile = p.join(claudeDir, '.makeloop-installed.json');
  const installedFile = p.join(claudeDir, 'plugins', 'installed_plugins.json'), knownFile = p.join(claudeDir, 'plugins', 'known_marketplaces.json');
  if (dryRun) return { dryRun: true, plan: ['claude plugin marketplace add usedhonda/makeloop (known marketplace: skip; EBUSY: local clone fallback)', `claude plugin install ${PLUGIN} (already in installed_plugins.json: skip)`, `read-back ${installedFile}`, 'WSL and native: codex plugin marketplace add usedhonda/makeloop; codex plugin add makeloop@makeloop (cache exists: skip)', `write ${markerFile}`], exitCode: 0 };
  const errors = [];
  const invoke = (exe, args) => {
    // Only controlled arguments enter cmd; reject metacharacters from local paths.
    let command = exe, commandArgs = args;
    if (platform === 'win32' && ['claude', 'codex'].includes(exe)) {
      if (args.some(arg => /["%\r\n!&|<>^]/.test(arg))) throw new Error('Unsafe cmd argument');
      // .cmd シムは引用符を実体へそのまま渡すので、空白を含む引数だけ引用する（codex "plugin" は unexpected argument になる）。
      command = 'cmd.exe'; commandArgs = ['/d', '/s', '/c', [exe, ...args.map(cmdQuote)].join(' ')];
    }
    // stdin は閉じる: CLI が端末入力を待って固まるのを防ぐ（2026-10-21 kim-PC 実測: パイプのままだと claude plugin list が ETIMEDOUT）。
    return spawnImpl(command, commandArgs, { encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] });
  };
  const ok = r => !r.error && r.status === 0;
  const detail = r => `${r.stdout || ''}\n${r.stderr || ''}\n${r.error?.message || ''}`;
  const requireOk = r => { if (!ok(r)) throw new Error(detail(r).slice(-1000)); return r; };
  const readText = file => { try { return read(file); } catch { return ''; } };
  const installed = () => installedPlugins(readText(installedFile)) !== null;
  let claude = false, codex = false;
  try {
    let known = {};
    try { known = JSON.parse(readText(knownFile)); } catch { /* absent */ }
    if (!known || !Object.hasOwn(known, 'makeloop')) {
      const added = invoke('claude', ['plugin', 'marketplace', 'add', 'usedhonda/makeloop']);
      if (!ok(added)) {
        if (!/EBUSY/i.test(detail(added)) || !/usedhonda-makeloop..clone/i.test(detail(added))) requireOk(added);
        const local = p.join(claudeDir, 'makeloop-src');
        requireOk(invoke('git', exists(local) ? ['-C', local, 'pull', '--ff-only'] : ['clone', 'https://github.com/usedhonda/makeloop.git', local]));
        requireOk(invoke('claude', ['plugin', 'marketplace', 'add', local]));
      }
    }
    if (installed()) log(`Claude ${PLUGIN} already installed: ${installedFile}`);
    else requireOk(invoke('claude', ['plugin', 'install', PLUGIN]));
    claude = installed();
    if (!claude) throw new Error(`${installedFile} does not list ${PLUGIN} after install`);
  } catch (error) { errors.push(`claude: ${error.message}`); }
  const host = wsl === undefined ? discoverWsl({ platform, spawnImpl }) : wsl;
  const targets = [...(host ? [{ exe: 'wsl', prefix: ['-d', host.distro, '--', 'codex'], home: host.home }] : []), { exe: 'codex', prefix: [], home }];
  for (const target of targets) {
    // WSL 側で導入済みなら Windows ネイティブ codex は触らない（ネイティブの plugin 系は 20 秒以上かかる）。
    if (codex && target.exe === 'codex') continue;
    try {
      const cache = p.join(target.home, '.codex', 'plugins', 'cache', 'makeloop');
      if (exists(cache)) { codex = true; log(`Codex makeloop already installed: ${cache}`); continue; }
      const added = invoke(target.exe, [...target.prefix, 'plugin', 'marketplace', 'add', 'usedhonda/makeloop']);
      if (!ok(added) && !/already (?:exists|registered|added)|既に.*登録/i.test(detail(added))) requireOk(added);
      requireOk(invoke(target.exe, [...target.prefix, 'plugin', 'add', PLUGIN]));
      if (!exists(cache)) throw new Error(`Codex cache missing: ${cache}`);
      codex = true;
    } catch (error) { errors.push(`${target.exe}: ${error.message}`); }
  }
  const marker = { claude, codex, at: new Date().toISOString() };
  write(markerFile, JSON.stringify(marker, null, 2) + '\n');
  return { ...marker, errors, exitCode: claude || codex ? 0 : 1 };
}
export function main(argv = process.argv.slice(2)) {
  const result = installMakeloop({ dryRun: argv.includes('--dry-run') }); console.log(JSON.stringify(result, null, 2)); return result.exitCode;
}
if (isEntry(import.meta.url)) { try { process.exitCode = main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
