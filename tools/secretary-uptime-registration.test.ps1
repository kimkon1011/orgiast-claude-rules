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
function New-ScheduledTaskPrincipal { return @{} }
function New-ScheduledTaskSettingsSet { return [pscustomobject]@{RunOnlyIfIdle=$false} }
function Register-ScheduledTask { $global:registered=$true }
function Disable-ScheduledTask { throw 'Unexpected real task mutation' }
function Enable-ScheduledTask { throw 'Unexpected real task mutation' }
function Get-Date { return $global:now }
function Start-Sleep { $global:now=$global:now.AddSeconds(10) }
function Get-ScheduledTask {
  param($TaskName)
  if ($TaskName -ne 'OrgiastFunnelProbe') { return $null }
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
foreach ($case in @('healthy','never-ran','result-one','stale-state','external-down','missing-build')) {
  $global:scenario=$case
  $global:start=[datetime]'2026-11-13T18:00:00'
  $global:now=$global:start
  $global:registered=$false
  $failure=$null
  try { $result=& $registration } catch { $failure=$_.Exception.Message }
  if ($case -eq 'healthy') {
    if ($failure) { throw $failure }
    $readback=$result | ConvertFrom-Json
    if ($readback.LastTaskResult -ne 0 -or $readback.Interval -ne 'PT5M' -or !$global:registered) { throw 'Healthy read-back failed' }
  } else {
    $expected=switch ($case) {
      'never-ran' {'First scheduled watchdog run was not confirmed successful'}
      'result-one' {'First scheduled watchdog run was not confirmed successful'}
      'stale-state' {'Watchdog state was not refreshed by scheduled execution'}
      'external-down' {'Scheduled watchdog did not confirm healthy HTTP: external'}
      'missing-build' {'Secretary production build is missing; apply-secretary-progress.ps1 builds it before registration'}
    }
    if ($failure -ne $expected) { throw "Unexpected result for ${case}: $failure" }
    if ($case -eq 'missing-build' -and $global:registered) { throw 'Registered a watchdog without a restartable build' }
  }
  Write-Output "PASS registration $case"
}
