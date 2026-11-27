#!/usr/bin/env node
/**
 * task-window-reset.mjs — 窓表示タスクの自動リセット
 *
 * 現在のユーザーの定期タスクのうち、コンソール窓を出す起動方式のものを検出し、
 * run-hidden.vbs（wscript経由・窓なし）へ包み直す。
 *
 * 使い方:
 *   node tools/task-window-reset.mjs              # 検出＋修復
 *   node tools/task-window-reset.mjs --dry-run    # 検出のみ（修復しない）
 *   node tools/task-window-reset.mjs --json       # JSON 出力
 *   node tools/task-window-reset.mjs --register   # 定期タスクとして登録（5分間隔）
 *
 * P-0014: 残存タスクによる業務遅延防止策 — タスク検出後に自動リセット処理を追加し、
 * 窓表示を防止するスクリプトを組み込む。
 */
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntry } from './is-entry.mjs';
import { classifyTaskActions, inspectTaskHiddenActions } from './setup-task-hidden-actions.mjs';

const __dirname = import.meta.dirname;
const REPO_ROOT = path.resolve(__dirname, '..');

/**
 * 現在のユーザーの定期タスク一覧を取得する（PowerShell）。
 * Get-ScheduledTask の結果を JSON で返す。
 */
function getScheduledTasks(spawnImpl = spawnSync) {
  const script = `
$tasks = @(Get-ScheduledTask | Select-Object TaskName, TaskPath, @{n='State';e={$_.State.ToString()}}, @{n='Actions';e={@($_.Actions | Select-Object Execute, Arguments)}})
$excludeFile = Join-Path $env:USERPROFILE '.claude\\task-hide-guard.exclude.txt'
$exclude = @()
if (Test-Path -LiteralPath $excludeFile) { $exclude = @(Get-Content -LiteralPath $excludeFile -Encoding UTF8 | ForEach-Object { ($_ -split '#', 2)[0].Trim() } | Where-Object { $_ }) }
ConvertTo-Json -InputObject @{ tasks = $tasks; exclude = $exclude } -Depth 6 -Compress
`;
  const result = spawnImpl('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8;\n${script}`, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (result.error || result.status !== 0) throw result.error || new Error(result.stderr || `PowerShell exit ${result.status}`);
  return JSON.parse(String(result.stdout).replace(/^﻿/, '').trim());
}

/**
 * 窓表示タスクを検出する。
 * @returns {{ names: string[], tasks: object[] }} 窓が出るタスク名の配列と元データ
 */
export function detectWindowTasks() {
  const raw = getScheduledTasks();
  const tasks = Array.isArray(raw) ? raw : raw.tasks;
  const exclude = Array.isArray(raw) ? [] : (raw.exclude || []);
  const names = classifyTaskActions(tasks, { exclude });
  return { names, tasks: tasks.filter(t => names.includes(t.TaskName)) };
}

/**
 * 窓表示タスクを run-hidden.vbs 経由に包み直す。
 * task-hide-guard.ps1 を呼び出す。
 * @returns {{ wrapped: number, skipped: number }}
 */
export function applyWindowTaskFix(spawnImpl = spawnSync) {
  const guardPs1 = path.join(REPO_ROOT, 'tools', 'task-hide-guard.ps1');
  if (!fs.existsSync(guardPs1)) throw new Error(`task-hide-guard.ps1 が見つかりません: ${guardPs1}`);
  const result = spawnImpl('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', guardPs1,
  ], { encoding: 'utf8', windowsHide: true, timeout: 600000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `task-hide-guard.ps1 exit=${result.status}`);
  const output = String(result.stdout).replace(/^﻿/, '').trim();
  // 出力から wrapped/skipped を抽出
  const match = output.match(/done wrapped=(\d+) skipped=(\d+)/);
  const wrapped = match ? parseInt(match[1], 10) : 0;
  const skipped = match ? parseInt(match[2], 10) : 0;
  return { wrapped, skipped, output };
}

/**
 * 検出＋修復を1度に行う。
 * @param {{ dryRun?: boolean }} options
 * @returns {{ detected: string[], wrapped: number, skipped: number }}
 */
export function resetWindowTasks(options = {}) {
  const { dryRun = false } = options;
  const { names, tasks } = detectWindowTasks();
  if (dryRun) return { detected: names, wrapped: 0, skipped: 0 };
  if (names.length === 0) return { detected: [], wrapped: 0, skipped: 0 };
  const result = applyWindowTaskFix();
  // 修復後に再検出して、残存を確認
  const { names: remaining } = detectWindowTasks();
  return { detected: names, wrapped: result.wrapped, skipped: result.skipped, remaining };
}

/**
 * task-window-reset を定期タスクとして登録する（5分間隔）。
 */
export function registerAsScheduledTask(options = {}) {
  const { dryRun = false, platform = process.platform, spawnImpl = spawnSync } = options;
  if (platform !== 'win32') return { skipped: 'Windows 以外はスキップ' };
  const home = process.env.USERPROFILE || os.homedir();
  const toolsDir = path.join(home, '.claude', 'tools');
  const vbs = path.join(toolsDir, 'run-hidden.vbs');
  const sourceVbs = path.join(REPO_ROOT, 'tools', 'run-hidden.vbs');
  const ensureRunHidden = path.join(REPO_ROOT, 'tools', 'ensure-run-hidden.ps1');
  if (!dryRun) {
    // run-hidden.vbs のコピーを確保
    fs.mkdirSync(toolsDir, { recursive: true });
    if (fs.existsSync(sourceVbs)) {
      const dest = path.join(toolsDir, 'run-hidden.vbs');
      if (!fs.existsSync(dest) || fs.readFileSync(sourceVbs, 'utf8') !== fs.readFileSync(dest, 'utf8')) {
        fs.copyFileSync(sourceVbs, dest);
      }
    }
  }
  const script = `
$ErrorActionPreference = 'Stop'
. '${ensureRunHidden.replace(/\\/g, '\\\\')}'
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = try { New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited } catch { $null }
$once = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$logon = try { New-ScheduledTaskTrigger -AtLogOn -User $user } catch { New-ScheduledTaskTrigger -AtLogOn }
$logon.Delay = 'PT1M'
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @(
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '${path.join(REPO_ROOT, 'tools', 'task-window-reset.mjs').replace(/\\/g, '\\\\')}'
)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
if ($principal) {
  try { Register-ScheduledTask -TaskName 'OrgiastTaskWindowReset' -Action $action -Trigger @($logon, $once) -Settings $settings -Principal $principal -Force | Out-Null }
  catch { Register-ScheduledTask -TaskName 'OrgiastTaskWindowReset' -Action $action -Trigger @($logon, $once) -Settings $settings -Force | Out-Null }
} else {
  Register-ScheduledTask -TaskName 'OrgiastTaskWindowReset' -Action $action -Trigger @($logon, $once) -Settings $settings -Force | Out-Null
}
Write-Output 'OK: OrgiastTaskWindowReset registered'
`;
  if (dryRun) return { plan: 'OrgiastTaskWindowReset (5 minutes, logon + once)' };
  const result = spawnImpl('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8;\n${script}`, 'utf16le').toString('base64'),
  ], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `register exit ${result.status}`);
  return { registered: true, output: String(result.stdout).replace(/^﻿/, '').trim() };
}

export function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes('--dry-run');
  const jsonOutput = argv.includes('--json');
  const register = argv.includes('--register');
  if (register) {
    const result = registerAsScheduledTask({ dryRun });
    if (jsonOutput) { console.log(JSON.stringify(result)); return 0; }
    console.log(dryRun ? JSON.stringify(result) : result.output || JSON.stringify(result));
    return 0;
  }
  const { names } = detectWindowTasks();
  if (names.length === 0) {
    if (jsonOutput) { console.log(JSON.stringify({ detected: [], status: 'clean' })); return 0; }
    console.log('窓が出る起動の定期タスクはありません');
    return 0;
  }
  if (jsonOutput) {
    if (dryRun) { console.log(JSON.stringify({ detected: names, status: 'dry-run' })); return 0; }
    const result = resetWindowTasks();
    console.log(JSON.stringify(result));
    return result.remaining?.length ? 1 : 0;
  }
  console.log(`窓が出る起動を検出: ${names.join(', ')}`);
  if (dryRun) {
    console.log('--dry-run のため修復しません。--register で定期タスク化できます');
    return 0;
  }
  console.log('task-hide-guard.ps1 で包み直しを実行します…');
  const result = applyWindowTaskFix();
  console.log(`修復完了: wrapped=${result.wrapped} / skipped=${result.skipped}`);
  const { names: remaining } = detectWindowTasks();
  if (remaining.length) {
    console.log(`⚠ 修復後も窓が出るタスクが残っています: ${remaining.join(', ')}`);
    return 1;
  }
  console.log('✅ すべての窓表示タスクを修復しました');
  return 0;
}

if (isEntry(import.meta.url)) process.exitCode = main(process.argv.slice(2));