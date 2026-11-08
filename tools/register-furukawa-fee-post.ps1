# Register the daily furukawa fee post at 09:15 JST.
# Run: powershell -ExecutionPolicy Bypass -File "<this file>"
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\furukawa-fee-post.mjs')
$script = Join-Path $repo 'tools\furukawa-fee-post.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 09:15
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'OrgiastFurukawaFeePost' -Action $action -Trigger $trigger -Settings $settings -Description 'Daily 09:15 JST: Post Furukawa M iho s monthly freelance fee to the assistant task ledger' -Force | Out-Null
Write-Host ("OK: task OrgiastFurukawaFeePost registered (daily 09:15)")
Get-ScheduledTask -TaskName 'OrgiastFurukawaFeePost' | Select-Object TaskName, State