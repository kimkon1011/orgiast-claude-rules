# Exercises the real registration script with all task/file mutations mocked.
$ErrorActionPreference='Stop'
$env:ORGIAST_NIGHTLY_REPO=Split-Path -Parent $PSScriptRoot
$registration=Join-Path $PSScriptRoot 'register-secretary-uptime.ps1'
function Test-Path {
  param($LiteralPath)
  if ($global:scenario -eq 'missing-build' -and $LiteralPath -match 'secretary-pc.*BUILD_ID$') { return $false }
  return $true
}
function New-ScheduledTaskAction { return @{} }
function New-ScheduledTaskTrigger { return @{} }
function New-ScheduledTaskPrincipal {
  param($UserId,$LogonType,$RunLevel)
  if ($LogonType -ne 'Interactive' -or $RunLevel -ne 'Limited') { throw 'Registration must not require elevation or a password' }
  return @{}
}
function New-ScheduledTaskSettingsSet { return [pscustomobject]@{RunOnlyIfIdle=$false} }
function Register-ScheduledTask { $global:registered=$true }
function Disable-ScheduledTask {
  param($TaskName)
  if ($TaskName -eq 'ClaudeMobile-WebServer') { throw [System.UnauthorizedAccessException]::new('Access is denied. (0x80070005)') }
  throw 'Unexpected real task mutation'
}
function New-Item {}
function Set-Content {}
# COM is unavailable in the portable mock test; the evidence records that failure.
function Export-ScheduledTask {
  $command=Join-Path $env:WINDIR 'System32\wscript.exe'
  $app=Join-Path $env:USERPROFILE 'Downloads\claude-mobile'
  $hidden=Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
  $node=Join-Path $env:ProgramFiles 'nodejs\node.exe'
  $next=Join-Path $app 'node_modules\next\dist\bin\next'
  $trigger=if ($global:scenario -eq 'unsafe-trigger') {'CalendarTrigger'} else {'LogonTrigger'}
  $port=if ($global:scenario -eq 'unsafe-action') {'3941'} else {'3939'}
  return @"
<Task xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><Triggers><$trigger><Enabled>true</Enabled></$trigger></Triggers><Actions><Exec><Command>$command</Command><Arguments>//nologo "$hidden" "$node" "$next" "start" "-H" "0.0.0.0" "-p" "$port"</Arguments><WorkingDirectory>$app</WorkingDirectory></Exec></Actions></Task>
"@
}
function Enable-ScheduledTask { throw 'Unexpected real task mutation' }
function Get-Date { return $global:now }
function Start-Sleep { $global:now=$global:now.AddSeconds(10) }
function Get-ScheduledTask {
  param($TaskName)
  if ($TaskName -ne 'OrgiastFunnelProbe') {
    if ($TaskName -eq 'ClaudeMobile-WebServer' -and $global:scenario -in @('legacy-denied','unsafe-trigger','unsafe-action')) { return [pscustomobject]@{State='Ready'} }
    return $null
  }
  return [pscustomobject]@{State='Ready';Settings=[pscustomobject]@{RunOnlyIfIdle=$false};Triggers=@([pscustomobject]@{Repetition=[pscustomobject]@{Interval='PT5M'}})}
}
function Get-ScheduledTaskInfo {
  $ran=$global:scenario -ne 'never-ran' -and $global:now -ge $global:start.AddMinutes(1)
  return [pscustomobject]@{LastRunTime=$(if ($ran) {$global:start.AddMinutes(1)} else {$global:start.AddDays(-1)});LastTaskResult=$(if ($global:scenario -eq 'result-one') {1} else {0})}
}
function Get-Content {
  $checked=if ($global:scenario -eq 'stale-state') {$global:start.AddDays(-1)} else {$global:start.AddMinutes(1)}
  return @{checkedAt=$checked.ToUniversalTime().ToString('o');after=@{external=@{ok=$global:scenario -ne 'external-down'};gateway=@{ok=$true};secretary=@{ok=$true}}} | ConvertTo-Json -Depth 4
}
foreach ($case in @('healthy','never-ran','result-one','stale-state','external-down','missing-build','legacy-denied','unsafe-trigger','unsafe-action')) {
  $global:scenario=$case
  $global:start=[datetime]'2026-11-13T18:00:00'
  $global:now=$global:start
  $global:registered=$false
  $failure=$null
  try { $result=& $registration } catch { $failure=$_.Exception.Message }
  if ($case -in @('healthy','legacy-denied')) {
    if ($failure) { throw $failure }
    $readback=$result | ConvertFrom-Json
    if ($readback.LastTaskResult -ne 0 -or $readback.Interval -ne 'PT5M' -or !$global:registered) { throw 'Healthy read-back failed' }
  } else {
    $expected=switch ($case) {
      'unsafe-trigger' {'Access is denied. (0x80070005)'}
      'unsafe-action' {'Access is denied. (0x80070005)'}
      'never-ran' {'First scheduled watchdog run was not confirmed successful'}
      'result-one' {'First scheduled watchdog run was not confirmed successful'}
      'stale-state' {'Watchdog state was not refreshed by scheduled execution'}
      'external-down' {'Scheduled watchdog did not confirm healthy HTTP: external'}
      'missing-build' {'Secretary production build is missing; apply-secretary-progress.ps1 builds it before registration'}
    }
    if ($failure -ne $expected) { throw "Unexpected result for ${case}: $failure" }
    if ($case -in @('missing-build','unsafe-trigger','unsafe-action') -and $global:registered) { throw 'Registered a watchdog without a restartable build' }
  }
  Write-Output "PASS registration $case"
}
