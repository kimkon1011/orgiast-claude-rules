#!/usr/bin/env node
// Windows-only creation; dependency injection lets tests model redirected folders.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { isEntry } from './is-entry.mjs';

export function resolveFolders(exec = execFileSync) {
  const script = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false); @{ desktop = [Environment]::GetFolderPath('Desktop'); localAppData = [Environment]::GetFolderPath('LocalApplicationData') } | ConvertTo-Json -Compress";
  const result = JSON.parse(exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15000 }).replace(/^\uFEFF/, '').trim());
  for (const key of ['desktop', 'localAppData']) {
    if (!result[key] || !path.win32.isAbsolute(result[key])) throw new Error(`Cannot resolve ${key}`);
  }
  return result;
}

function validateName(name) {
  if (!name || /[<>:"/\\|?*\x00-\x1f]/.test(name) || /[. ]$/.test(name) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(name) || name === '..') throw new Error('Invalid Windows file name');
}
function batchPath(value) {
  if (/["\r\n\x00]/.test(value)) throw new Error('Invalid script path');
  return value.replace(/%/g, '%%');
}
// 既定ブラウザで URL を開くと、どのアカウントで開くかが人任せになる（2026-11-01 Codex 再ログインで実害）。
const defaultBrowserOpen = /(?:Start-Process|\bstart\b|explorer(?:\.exe)?|Process\]::Start)\s*(?:-FilePath\s+)?\(?\s*['"]?https?:\/\//i;
export function findDefaultBrowserOpens(source) {
  return String(source).split(/\r?\n/).filter(line => !/^\s*#/.test(line) && defaultBrowserOpen.test(line));
}

export function renderLauncher(psFile, verifyCmd) {
  const lines = ['@echo off', 'chcp 65001 >nul', 'setlocal DisableDelayedExpansion', 'set "launcher_ps=pwsh.exe"', 'where pwsh.exe >nul 2>nul', 'if errorlevel 1 set "launcher_ps=powershell.exe"', `"%launcher_ps%" -NoProfile -ExecutionPolicy Bypass -File "${batchPath(psFile)}"`, 'set "launcher_result=%errorlevel%"'];
  if (verifyCmd) {
    // EncodedCommand avoids cmd.exe interpreting PowerShell quotes/metacharacters.
    const encoded = Buffer.from(`$ErrorActionPreference = 'Stop'\n${verifyCmd}`, 'utf16le').toString('base64');
    lines.push('if not "%launcher_result%"=="0" goto result', `"%launcher_ps%" -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`, 'set "launcher_result=%errorlevel%"');
  }
  lines.push(':result', 'echo Exit code: %launcher_result%', 'if "%launcher_result%"=="0" (echo OK) else (echo ERROR)', 'echo Press any key to close.', 'pause >nul', 'exit /b %launcher_result%', '');
  return lines.join('\r\n');
}

export function makeLauncher(options, { resolve = resolveFolders, io = fs, paths = path.win32 } = {}) {
  const { name, psFile, commandFile, verifyCmd, remove = false } = options;
  validateName(name);
  if (!remove && Boolean(psFile) === Boolean(commandFile)) throw new Error('Supply exactly one of --ps-file or --command-file');
  if (psFile && (!paths.isAbsolute(psFile) || !/\.ps1$/i.test(psFile))) throw new Error('--ps-file must be an absolute .ps1 path');
  const { desktop, localAppData } = resolve();
  const cmdPath = paths.join(desktop, `${name}（ダブルクリック）.cmd`);
  const managedPsPath = paths.join(localAppData, 'orgiast-launchers', `${name}.ps1`);
  if (remove) {
    io.rmSync(cmdPath, { force: true });
    // Only delete our managed copy, never the caller's --ps-file.
    io.rmSync(managedPsPath, { force: true });
    return { removed: true, cmdPath, managedPsPath };
  }
  const scriptPath = commandFile ? managedPsPath : psFile;
  const content = renderLauncher(scriptPath, verifyCmd);
  const source = io.readFileSync(commandFile || psFile, 'utf8');
  const opens = options.allowDefaultBrowser ? [] : findDefaultBrowserOpens(source);
  if (opens.length) throw new Error(`URL を既定のブラウザで開いています。tools/open-url-as.ps1 -Account <開く人のメール> -Url <URL> で開いてください（ONBOARDING §1.5.0）。アカウントに依存しない公開ページだけなら --allow-default-browser。\n${opens.join('\n')}`);
  if (commandFile) {
    io.mkdirSync(paths.dirname(managedPsPath), { recursive: true });
    // Windows PowerShell 5.1 needs BOM for Japanese script bodies.
    io.writeFileSync(managedPsPath, '\uFEFF' + source.replace(/^\uFEFF/, ''), 'utf8');
  }
  io.mkdirSync(desktop, { recursive: true });
  io.writeFileSync(cmdPath, content, 'utf8');
  return { cmdPath, psPath: scriptPath, verifyCmd: verifyCmd || null };
}

if (isEntry(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { name: { type: 'string' }, 'ps-file': { type: 'string' }, 'command-file': { type: 'string' }, 'verify-cmd': { type: 'string' }, remove: { type: 'boolean' }, 'allow-default-browser': { type: 'boolean' } } });
    const result = makeLauncher({ name: values.name, psFile: values['ps-file'], commandFile: values['command-file'], verifyCmd: values['verify-cmd'], remove: values.remove, allowDefaultBrowser: values['allow-default-browser'] });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
