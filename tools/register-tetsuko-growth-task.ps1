# ASCII-only on purpose: Windows PowerShell 5.1 decodes BOM-less files as Shift-JIS,
# so non-ASCII comments here break parsing (same rule as resolve-synced-repo.ps1).
#
# Register OrgiastTetsukoGrowth as a hidden daily task at 06:30.
param(
  [switch]$Unregister,
  [switch]$DryRun
)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastTetsukoGrowth'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "OK: task $taskName unregistered"
  } else {
    Write-Host "OK: task $taskName was not registered"
  }
  exit 0
}

. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# The task must run from the synced repo, not from the tree this script sits in.
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\tetsuko-growth-loop.mjs', 'tools\nightly-bootstrap.ps1')
$target = 'tools\tetsuko-growth-loop.mjs'
$script = Join-Path $repo $target
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "tetsuko-growth-loop.mjs not found: $script" }
$bootstrapSource = Join-Path $repo 'tools\nightly-bootstrap.ps1'
if (-not (Test-Path -LiteralPath $bootstrapSource -PathType Leaf)) { throw "nightly-bootstrap.ps1 not found: $bootstrapSource" }

if ($DryRun) {
  Write-Host "DryRun: TaskName = $taskName"
  Write-Host "DryRun: Repo = $repo"
  Write-Host "DryRun: Target = $target"
  Write-Host "DryRun: Trigger = Daily 06:30"
  exit 0
}

$bootstrapDir = Join-Path $env:USERPROFILE '.claude\tools'
$bootstrap = Join-Path $bootstrapDir 'nightly-bootstrap.ps1'
New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
Copy-Item -LiteralPath $bootstrapSource -Destination $bootstrap -Force

. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', $target) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '06:30'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'TETSUKO growth loop (daily 06:30; generates content and rewrites TETSUKO_DAILY_BRIEFING.md)' -Force -ErrorAction Stop | Out-Null
Write-Host "OK: task $taskName registered (daily 06:30)"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
