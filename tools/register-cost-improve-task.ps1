# AIコスト改善閉ループを毎日 07:20 に実行する。
# Windows PowerShell 5.1 で日本語を安全に扱うため UTF-8 BOM で保存する。
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$target = 'tools\cost-improve-loop.mjs'
$script = Join-Path $repo $target
if (-not (Test-Path $script)) { throw "script not found: $script" }
$bootstrapSource = Join-Path $repo 'tools\nightly-bootstrap.ps1'
if (-not (Test-Path $bootstrapSource)) { throw "bootstrap not found: $bootstrapSource" }
$bootstrapDir = Join-Path $env:USERPROFILE '.claude\tools'
$bootstrap = Join-Path $bootstrapDir 'nightly-bootstrap.ps1'
New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
Copy-Item -LiteralPath $bootstrapSource -Destination $bootstrap -Force

$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', $target) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '07:20'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 60)

Register-ScheduledTask -TaskName 'OrgiastCostImproveLoop' -Action $action -Trigger $trigger -Settings $settings -Description 'AIコスト効率の計測・自動改善・効果検証（毎日07:20）' -Force | Out-Null
Write-Host 'OK: task OrgiastCostImproveLoop registered (daily 07:20)'
Get-ScheduledTask -TaskName 'OrgiastCostImproveLoop' | Select-Object TaskName, State
