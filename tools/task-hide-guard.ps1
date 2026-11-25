$ErrorActionPreference = 'Stop'
Write-Output ("{0:s} start" -f (Get-Date))
$wrapped = 0; $skipped = 0
$excludeFile = Join-Path $env:USERPROFILE '.claude\task-hide-guard.exclude.txt'
$exclude = @()
if (Test-Path -LiteralPath $excludeFile) {
  $exclude = @(Get-Content -LiteralPath $excludeFile -Encoding UTF8 | ForEach-Object { ($_ -split '#', 2)[0].Trim() } | Where-Object { $_ })
}
$vbs = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
$source = Join-Path $PSScriptRoot 'run-hidden.vbs'
if (-not (Test-Path -LiteralPath $vbs) -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $vbs -Algorithm SHA256).Hash) {
  New-Item -ItemType Directory -Path (Split-Path $vbs) -Force | Out-Null
  $temp = $vbs + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
  try {
    Copy-Item -LiteralPath $source -Destination $temp
    Move-Item -LiteralPath $temp -Destination $vbs -Force
  } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
function Split-Args([string]$s) {
  $out = @(); foreach ($m in [regex]::Matches($s, '"([^"]*)"|(\S+)')) { if ($m.Groups[1].Success) { $out += $m.Groups[1].Value } else { $out += $m.Groups[2].Value } }; return $out
}
$tasks = Get-ScheduledTask | Where-Object { $_.State -ne 'Disabled' -and $_.TaskPath -notlike '\Microsoft\*' }
foreach ($t in $tasks) {
  if ($exclude -contains $t.TaskName -or $exclude -contains ($t.TaskPath + $t.TaskName)) {
    "{0:s} EXCLUDED {1}{2}" -f (Get-Date), $t.TaskPath, $t.TaskName
    $skipped++; continue
  }
  $changed = $false; $newActions = @()
  foreach ($a in $t.Actions) {
    $exe = ($a.Execute + '').Trim('"')
    $name = [IO.Path]::GetFileName($exe).ToLower()
    if (($a.Arguments + '') -match '(?i)run-hidden\.vbs') { $newActions += $a; continue }
    if ($name -match '^(powershell|pwsh|cmd|node|python|bash|wsl)(\.exe)?$|\.(bat|cmd)$') {
      $parts = @($exe) + (Split-Args ($a.Arguments + ''))
      $argStr = '//nologo "' + $vbs + '" ' + (($parts | ForEach-Object { '"' + $_ + '"' }) -join ' ')
      if ($a.WorkingDirectory) { $newActions += New-ScheduledTaskAction -Execute $wscript -Argument $argStr -WorkingDirectory $a.WorkingDirectory }
      else { $newActions += New-ScheduledTaskAction -Execute $wscript -Argument $argStr }
      $changed = $true
    } else { $newActions += $a }
  }
  if ($changed) {
    try {
      Set-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath -Action $newActions -ErrorAction Stop | Out-Null
      $wrapped++
      $v = (Get-ScheduledTask -TaskName $t.TaskName -TaskPath $t.TaskPath).Actions[0]
      "{0:s} OK {1}{2} => {3} {4}" -f (Get-Date), $t.TaskPath, $t.TaskName, $v.Execute, $v.Arguments
    } catch {
      $skipped++
      "{0:s} SKIP {1}{2} ({3})" -f (Get-Date), $t.TaskPath, $t.TaskName, $_.Exception.Message
    }
  } else {
    $skipped++
    "{0:s} SKIP {1}{2} (already hidden or no console action)" -f (Get-Date), $t.TaskPath, $t.TaskName
  }
}

"{0:s} done wrapped={1} skipped={2}" -f (Get-Date), $wrapped, $skipped
