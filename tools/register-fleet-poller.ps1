# Orgiast fleet poller(フリート自己点検)を毎日03:15に起動する。Windows PowerShell 5.1向けUTF-8 BOM。
# 実行対象(fleet-poller.ps1)は作業ツリーではなく nightly-bootstrap が origin/main へ同期した
# チェックアウト(~/.claude/nightly-repo)から実行する(2026-09-10・nightly-batch と同様の分離)。
param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastFleetPoller'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: task $taskName unregistered" }
  else { Write-Host "OK: task $taskName was not registered" }
  exit 0
}

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$target = 'tools\fleet-poller.ps1'
$script = Join-Path $repo $target
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "fleet-poller.ps1 not found: $script" }
$bootstrapSource = Join-Path $repo 'tools\nightly-bootstrap.ps1'
if (-not (Test-Path -LiteralPath $bootstrapSource -PathType Leaf)) { throw "nightly-bootstrap.ps1 not found: $bootstrapSource" }
$bootstrapDir = Join-Path $env:USERPROFILE '.claude\tools'
$bootstrap = Join-Path $bootstrapDir 'nightly-bootstrap.ps1'
New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
Copy-Item -LiteralPath $bootstrapSource -Destination $bootstrap -Force

. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', $target) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '03:15'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force -ErrorAction Stop | Out-Null
Write-Host "OK: task $taskName registered (daily 03:15)"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
