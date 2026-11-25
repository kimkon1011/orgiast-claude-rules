# Detects visible console/terminal windows appearing on screen (Windows Terminal,
# legacy conhost, mintty, etc.) and records the owning process plus every process
# created in the preceding seconds with its parent chain, so the origin of a
# flashing window can be identified afterwards.
# Log: %USERPROFILE%\.claude\logs\window-spawn-watch.events.log
# (window-spawn-watch.log is taken by run-hidden.vbs stdout redirect)
param([int]$IntervalMs = 300, [int]$LookbackSec = 20)

$log = Join-Path $env:USERPROFILE '.claude\logs\window-spawn-watch.events.log'
$lock = Join-Path $env:USERPROFILE '.claude\logs\window-spawn-watch.pid'
New-Item -ItemType Directory -Path (Split-Path $log) -Force | Out-Null
if (Test-Path $lock) {
  $old = Get-Content $lock -ErrorAction SilentlyContinue
  if ($old -and $old -ne "$PID" -and (Get-Process -Id $old -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'powershell|pwsh' })) { exit 0 }
}
Set-Content -Path $lock -Value $PID

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class WinEnum {
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  public static List<string> Consoles() {
    var r = new List<string>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var c = new StringBuilder(256); GetClassName(h, c, 256);
      string cls = c.ToString();
      if (cls == "ConsoleWindowClass" || cls == "CASCADIA_HOSTING_WINDOW_CLASS" || cls == "mintty" || cls == "PseudoConsoleWindow") {
        var t = new StringBuilder(512); GetWindowText(h, t, 512);
        uint pid; GetWindowThreadProcessId(h, out pid);
        r.Add(h.ToInt64() + "\t" + cls + "\t" + pid + "\t" + t.ToString());
      }
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
'@

function Write-Log([string]$s) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 2MB) { Move-Item $log "$log.1" -Force }
  Add-Content -Path $log -Value $s -Encoding utf8
}

$seen = @{}
foreach ($w in [WinEnum]::Consoles()) { $seen[($w -split "`t")[0]] = $true }
Write-Log ("{0} start pid={1} baseline={2}" -f (Get-Date -Format s), $PID, $seen.Count)

while ($true) {
  Start-Sleep -Milliseconds $IntervalMs
  $now = [WinEnum]::Consoles()
  $cur = @{}; $new = @()
  foreach ($w in $now) { $h = ($w -split "`t")[0]; $cur[$h] = $true; if (-not $seen.ContainsKey($h)) { $new += $w } }
  $seen = $cur
  if ($new.Count -eq 0) { continue }
  $since = (Get-Date).AddSeconds(-$LookbackSec)
  $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
  $byId = @{}; $all | ForEach-Object { $byId[[int]$_.ProcessId] = $_ }
  Write-Log ("=== {0} new visible window" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'))
  foreach ($w in $new) {
    $f = $w -split "`t"; $o = $byId[[int]$f[2]]
    Write-Log ("  WINDOW class={0} title='{1}' owner={2}#{3}" -f $f[1], $f[3], $(if ($o) { $o.Name } else { '?' }), $f[2])
  }
  $all | Where-Object { $_.CreationDate -gt $since } | Sort-Object CreationDate | ForEach-Object {
    $chain = @(); $p = $byId[[int]$_.ParentProcessId]; $guard = 0
    while ($p -and $guard -lt 6) { $chain += "$($p.Name)#$($p.ProcessId)"; $p = $byId[[int]$p.ParentProcessId]; $guard++ }
    $cmd = if ($_.CommandLine) { $_.CommandLine.Substring(0, [Math]::Min(300, $_.CommandLine.Length)) } else { '' }
    Write-Log ("  {0} {1}#{2} <- {3} | {4}" -f $_.CreationDate.ToString('HH:mm:ss.fff'), $_.Name, $_.ProcessId, ($chain -join ' <- '), $cmd)
  }
}
