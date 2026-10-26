import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function classifyTaskActions(list, { exclude = [] } = {}) {
  if (!Array.isArray(list)) throw new Error('task list must be an array');
  const excluded = new Set([...exclude].map(name => String(name).split('#')[0].trim().toLowerCase()).filter(Boolean));
  return [...new Set(list.filter(task => String(task.State).toLowerCase() !== 'disabled' && task.State !== 1)
    .filter(task => !/^\\Microsoft\\/i.test(task.TaskPath ?? ''))
    .filter(task => !excluded.has(String(task.TaskName).toLowerCase()) && !excluded.has(`${task.TaskPath ?? ''}${task.TaskName}`.toLowerCase()))
    .filter(task => (Array.isArray(task.Actions) ? task.Actions : [task.Actions]).some(action => {
      if (/run-hidden\.vbs/i.test(action?.Arguments ?? '')) return false;
      const execute = String(action?.Execute ?? '').trim().replace(/^"|"$/g, '');
      return /^(powershell|pwsh|cmd|node|python|bash|wsl)(\.exe)?$|\.(bat|cmd)$/i.test(execute.split(/[\\/]/).at(-1));
    })).map(task => task.TaskName))];
}

// Read the persisted user value: a long-running parent can have a stale environment.
const telemetryScript = `
if ([Environment]::GetEnvironmentVariable('GH_TELEMETRY', 'User') -eq '0') { 'unchanged'; exit }
[Environment]::SetEnvironmentVariable('GH_TELEMETRY', '0', 'User')
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TaskHideEnvironment {
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);
}
'@
$result = [UIntPtr]::Zero
[void][TaskHideEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x001a, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
'changed'
`;
const inspectScript = `
$tasks = @(Get-ScheduledTask | Select-Object TaskName, TaskPath, @{n='State';e={$_.State.ToString()}}, @{n='Actions';e={@($_.Actions | Select-Object Execute, Arguments)}})
$file = Join-Path $env:USERPROFILE '.claude\\task-hide-guard.exclude.txt'
$exclude = @()
if (Test-Path -LiteralPath $file) { $exclude = @(Get-Content -LiteralPath $file -Encoding UTF8 | ForEach-Object { ($_ -split '#', 2)[0].Trim() } | Where-Object { $_ }) }
ConvertTo-Json -InputObject @{ tasks = $tasks; exclude = $exclude } -Depth 6 -Compress
`;
export function inspectTaskHiddenActions({ platform = process.platform, run = execFileSync, converge = false } = {}) {
  const result = { checked: true, repaired: false };
  if (platform !== 'win32') return { ...result, checked: false, status: 'NOTICE', description: 'Windows 以外はスキップ' };
  const options = { encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: ['ignore', 'pipe', 'pipe'] };
  const ps = script => String(run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8;\n${script}`, 'utf16le').toString('base64')], options)).replace(/^\uFEFF/, '').trim();
  const inspect = () => {
    const data = JSON.parse(ps(inspectScript));
    return Array.isArray(data) ? classifyTaskActions(data) : classifyTaskActions(data.tasks, { exclude: data.exclude });
  };
  let telemetry = '';
  try {
    if (converge) {
      const changed = ps(telemetryScript);
      if (!['changed', 'unchanged'].includes(changed)) throw new Error('GH_TELEMETRY 設定結果不明');
      result.repaired = changed === 'changed';
      telemetry = result.repaired ? ' / GH_TELEMETRY=0 設定' : ' / GH_TELEMETRY=0 変更なし';
    }
    let names = inspect();
    if (converge && names.length) {
      const before = names;
      run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./task-hide-guard.ps1', import.meta.url))], { ...options, timeout: 600000 });
      names = inspect();
      result.repaired ||= before.some(name => !names.includes(name));
    }
    return { ...result, status: names.length ? 'NG' : 'OK', description: (names.length ? `窓が出る起動: ${names.join(',')}` : '窓が出る起動なし') + telemetry };
  } catch { return { ...result, status: 'NOTICE', description: '定期タスクの列挙・修復または GH_TELEMETRY 設定に失敗' + telemetry }; }
}
