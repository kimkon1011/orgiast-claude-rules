#!/usr/bin/env node
// C③: 配布される hook 集合が platform ごとの要件を満たすか検査する。
// 既定の検査対象は register-hooks.mjs が生成する「配布正本」の hook 集合。
// --settings <file> を渡すと、その settings.json をそのまま監査する（既存PCの実挙動確認用）。
//
// 要件:
// - linux/darwin: PowerShell 依存 hook（pwsh/powershell/.ps1）が 0。
// - win32: 生成 hook 総数がベースラインから減っていない（--baseline 指定時）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { platformName } from '../lib/platform.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const powershellDependent = /\b(?:pwsh|powershell)(?:\.exe)?\b|\.ps1\b/i;

export function countHooks(settings) {
  const hooks = Object.values(settings?.hooks || {})
    .filter(Array.isArray)
    .flatMap((groups) => groups.flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : [])))
    .filter((hook) => hook && typeof hook === 'object');
  return {
    total: hooks.length,
    pwshDependent: hooks.filter((hook) => powershellDependent.test(String(hook.command || ''))).length,
  };
}

export function generatedHooks(platform = platformName(), repo = repoRoot) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'check-hooks-'));
  try {
    const stdout = execFileSync(process.execPath, [path.join(repo, 'tools', 'register-hooks.mjs'), '--expected-json'], {
      encoding: 'utf8',
      env: { ...process.env, ORGIAST_REPO: repo, ORGIAST_HOME: home, ORGIAST_PLATFORM: platform },
      windowsHide: true,
    });
    return JSON.parse(stdout).hooks || {};
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function cli(argv) {
  let platform = platformName();
  let settingsFile;
  let baselineFile = path.join(repoRoot, 'reports', 'linux-port-hooks.baseline.json');
  let writeBaseline = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--platform' && argv[i + 1]) platform = argv[++i];
    else if (argv[i] === '--settings' && argv[i + 1]) settingsFile = path.resolve(argv[++i]);
    else if (argv[i] === '--baseline' && argv[i + 1]) baselineFile = path.resolve(argv[++i]);
    else if (argv[i] === '--write-baseline') writeBaseline = true;
    else throw new Error(`Unknown option or missing value: ${argv[i]}`);
  }
  if (!['linux', 'darwin', 'win32'].includes(platform)) throw new Error(`Unknown platform: ${platform}`);
  const source = settingsFile ? path.basename(settingsFile) : 'register-hooks --expected-json';
  const hooks = settingsFile ? JSON.parse(fs.readFileSync(settingsFile, 'utf8').replace(/^﻿/, '')).hooks || {} : generatedHooks(platform);
  const result = countHooks({ hooks });
  console.log(`platform: ${platform}`);
  console.log(`source: ${source}`);
  console.log(`hook total: ${result.total}`);
  console.log(`pwsh-dependent hooks: ${result.pwshDependent}`);

  if (platform !== 'win32' && result.pwshDependent > 0) {
    console.error(`NG: ${platform} の配布 hook に PowerShell 依存が ${result.pwshDependent} 件あります`);
    process.exitCode = 1;
    return;
  }
  if (writeBaseline) {
    fs.mkdirSync(path.dirname(baselineFile), { recursive: true });
    const all = fs.existsSync(baselineFile) ? JSON.parse(fs.readFileSync(baselineFile, 'utf8')) : {};
    all[platform] = { total: result.total, pwshDependent: result.pwshDependent };
    fs.writeFileSync(baselineFile, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
    console.log(`baseline updated: ${path.relative(repoRoot, baselineFile)}`);
    return;
  }
  // ベースラインは配布正本の総数に対するラチェット。--settings で実PCの一部を
  // 監査するときは総数が少ないのが正常なので比較しない。
  if (platform === 'win32' && !settingsFile && fs.existsSync(baselineFile)) {
    const baseline = JSON.parse(fs.readFileSync(baselineFile, 'utf8'))[platform];
    if (baseline && Number.isFinite(baseline.total) && result.total < baseline.total) {
      console.error(`NG: win32 の hook 総数が ${baseline.total} -> ${result.total} に減少しました`);
      process.exitCode = 1;
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { cli(process.argv.slice(2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
