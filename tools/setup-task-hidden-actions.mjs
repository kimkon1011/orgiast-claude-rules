import { execFileSync } from 'node:child_process';

export function classifyTaskActions(list) {
  if (!Array.isArray(list)) throw new Error('task list must be an array');
  return [...new Set(list.filter(task => String(task.State).toLowerCase() !== 'disabled' && task.State !== 1)
    .filter(task => (Array.isArray(task.Actions) ? task.Actions : [task.Actions]).some(action => {
      const execute = String(action?.Execute ?? '').trim().replace(/^"|"$/g, '');
      return execute && execute.split(/[\\/]/).at(-1).toLowerCase() !== 'wscript.exe';
    })).map(task => task.TaskName))];
}

export function inspectTaskHiddenActions({ platform = process.platform, run = execFileSync } = {}) {
  const result = { checked: true, repaired: false };
  if (platform !== 'win32') return { ...result, checked: false, status: 'NOTICE', description: 'Windows 以外はスキップ' };
  try {
    const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.Encoding]::UTF8; $tasks = @(Get-ScheduledTask -TaskName 'Orgiast*' | Select-Object TaskName, @{n='State';e={$_.State.ToString()}}, Actions); ConvertTo-Json -InputObject $tasks -Depth 6 -Compress`;
    const raw = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] });
    const names = classifyTaskActions(JSON.parse(String(raw).replace(/^\uFEFF/, '')));
    return { ...result, status: names.length ? 'NG' : 'OK', description: names.length ? `窓が出る起動: ${names.join(',')}` : '窓が出る起動なし' };
  } catch { return { ...result, status: 'NOTICE', description: '定期タスクの列挙に失敗' }; }
}
