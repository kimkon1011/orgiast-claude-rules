#!/usr/bin/env node
// Periodically lower claude.exe (VS Code extension / headless) priority to BelowNormal
// to prevent CPU contention with other apps, while leaving the Desktop App at Normal.
import { spawnSync } from 'node:child_process';
import { isEntry } from './is-entry.mjs';

const POWERSHELL_SCRIPT = `[Console]::OutputEncoding=[Text.Encoding]::UTF8
$ErrorActionPreference='Stop'
$rows = @(Get-CimInstance Win32_Process -Filter "Name='claude.exe'" | Select-Object Name,ExecutablePath,CommandLine,ProcessId)
$result = @{lowered=0; alreadyLow=0; excluded=0; failed=0}
foreach ($row in $rows) {
    $exePath = [string]$row.ExecutablePath
    if ($exePath.ToLower().Contains('\\windowsapps\\')) { $result.excluded++; continue }
    try {
        $proc = Get-Process -Id $row.ProcessId -ErrorAction Stop
        $current = $proc.PriorityClass
        if ($current -in @('BelowNormal', 'Idle')) { $result.alreadyLow++; continue }
        if ($current -ne 'Normal') { continue }
        $proc.PriorityClass = 'BelowNormal'
        $result.lowered++
    } catch { $result.failed++ }
}
ConvertTo-Json -InputObject $result -Compress`;

export function guardClaudePriority({ exec = spawnSync, platform = process.platform } = {}) {
  if (platform !== 'win32') return { skipped: 'non-win32' };
  try {
    const raw = exec('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT,
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    const stdout = typeof raw === 'string' ? raw : (raw.stdout ?? '');
    if (raw.error || raw.status != null && raw.status !== 0) throw new Error('PowerShell failed');
    const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim());
    for (const key of ['lowered', 'alreadyLow', 'excluded', 'failed']) {
      if (!Number.isInteger(result[key]) || result[key] < 0) throw new Error('Invalid counters');
    }
    return result;
  } catch {
    return { lowered: 0, alreadyLow: 0, excluded: 0, failed: 1 };
  }
}

if (isEntry(import.meta.url)) {
  const result = guardClaudePriority();
  console.log(JSON.stringify(result));
}
