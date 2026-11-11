param([switch]$DryRun, [switch]$Ensure, [switch]$Remove)
$ErrorActionPreference = 'Stop'
$map = Get-Content -LiteralPath (Join-Path (Split-Path -Parent $PSScriptRoot) 'fleet-pc-map.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($env:COMPUTERNAME -ine $map.'kim-PC'.hostname) { Write-Host 'skip: meeting-url-notice belongs to kim-PC'; exit 0 }

. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Get-SyncedRepoRoot) -RequiredPaths @('tools\meeting-url-notice.mjs', 'config\meeting-url-notice.json')
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$scriptPath = Join-Path $repo 'tools\meeting-url-notice.mjs'
$node = (Get-Command node -ErrorAction Stop).Source
$hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$taskName = 'OrgiastMeetingUrlNotice'

$current = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($Remove) {
  if ($current -and -not $DryRun) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
  exit 0
}
if (-not (Test-Path -LiteralPath $scriptPath)) { throw "Missing $scriptPath" }

$expectedArgs = '//nologo "{0}" "{1}" "{2}" --mode approve' -f $hidden, $node, $scriptPath
$timeLimit = 'PT15M'

if ($Ensure -and $current -and $current.Settings.ExecutionTimeLimit -eq $timeLimit -and $current.State -ne 'Disabled' -and @($current.Actions).Count -eq 1 -and $current.Actions[0].Execute -ieq $wscript -and $current.Actions[0].Arguments -eq $expectedArgs -and $current.Actions[0].WorkingDirectory -eq $repo) {
  Write-Host "ok: $taskName already registered"
  exit 0
}

if ($DryRun) {
  Write-Host "[DRY] $taskName: $expectedArgs (every 15 min)"
  exit 0
}

$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($scriptPath, '--mode', 'approve') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Check and send meeting URL notices and reminders every 15 minutes' -Force | Out-Null
Write-Host "ok: $taskName registered"
