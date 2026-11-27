# tl;dv followup wo 15 fun goto ni jikkou suru task wo touroku suru.
# Nando jikkou shitemo onaji task dake wo -Force de uwagaki suru.
# Log: %USERPROFILE%\.claude\logs\tldv-followup-dispatch.log
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# Douki zumi repo wo tsukau. Worktree kara wa jikkou shinai.
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\tldv-followup-dispatch.mjs')
$script = Join-Path $repo 'tools\tldv-followup-dispatch.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }
# run-hidden.vbs ga mjs no namae kara log path wo kimete hozon suru.
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 2)
Register-ScheduledTask -TaskName 'OrgiastTldvFollowupDispatch' -Action $action -Trigger $trigger -Settings $settings -Description 'Dispatch tl;dv follow-up every 15 minutes; no external messages' -Force | Out-Null
Write-Host 'OK: OrgiastTldvFollowupDispatch registered (every 15 minutes)'
Get-ScheduledTaskInfo -TaskName 'OrgiastTldvFollowupDispatch' | Select-Object NextRunTime
