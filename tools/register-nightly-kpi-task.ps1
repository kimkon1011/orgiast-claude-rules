# 夜間作業のKPIを毎日 07:05 に集計し、異常時は改善TODOを起票する。
# Windows PowerShell 5.1 で日本語を安全に扱うため UTF-8 BOM で保存する。
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$target = 'tools\nightly-kpi.mjs'
$script = Join-Path $repo $target
if (-not (Test-Path $script)) { throw "script not found: $script" }
$bootstrapSource = Join-Path $repo 'tools\nightly-bootstrap.ps1'
if (-not (Test-Path $bootstrapSource)) { throw "bootstrap not found: $bootstrapSource" }
$bootstrapDir = Join-Path $env:USERPROFILE '.claude\tools'
$bootstrap = Join-Path $bootstrapDir 'nightly-bootstrap.ps1'
New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
Copy-Item -LiteralPath $bootstrapSource -Destination $bootstrap -Force

$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', $target) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '07:05'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName 'OrgiastNightlyKpi' -Action $action -Trigger $trigger -Settings $settings -Description '夜間作業のKPI集計・異常検知・改善起票（毎日07:05）' -Force | Out-Null
Write-Host 'OK: task OrgiastNightlyKpi registered (daily 07:05)'
Get-ScheduledTask -TaskName 'OrgiastNightlyKpi' | Select-Object TaskName, State
