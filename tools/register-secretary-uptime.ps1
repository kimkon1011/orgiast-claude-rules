param([string]$ToolsDir=$PSScriptRoot)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$ToolsDir = Resolve-RegisterToolsDir -Fallback $ToolsDir -RequiredLeaves @('secretary-uptime.mjs','secretary-restart.ps1','kim-inbox.mjs','is-entry.mjs')
$watchdog = Join-Path $ToolsDir 'secretary-uptime.mjs'
$hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
foreach ($required in @($watchdog,$hidden,(Join-Path $ToolsDir 'secretary-restart.ps1'),(Join-Path $ToolsDir 'kim-inbox.mjs'))) {
  if (!(Test-Path -LiteralPath $required)) { throw "Missing dependency: $required" }
}
# A healthy dev process is not proof that next start can recover after a crash.
# Validate restart prerequisites before disabling any existing supervisor.
$gatewayBuild=Join-Path $env:USERPROFILE 'Downloads\claude-mobile\.next-production\BUILD_ID'
if (!(Test-Path -LiteralPath $gatewayBuild)) { throw 'Gateway production build is missing; build it before registering the watchdog' }
$secretaryProduction=Join-Path $env:USERPROFILE 'Downloads\secretary-pc\.next-production\BUILD_ID'
$secretaryBuild=Join-Path $env:USERPROFILE 'Downloads\secretary-pc\.next\BUILD_ID'
if (!(Test-Path -LiteralPath $secretaryProduction) -and !(Test-Path -LiteralPath $secretaryBuild)) {
  throw 'Secretary production build is missing; apply-secretary-progress.ps1 builds it before registration'
}
$taskName = 'OrgiastFunnelProbe'
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('//nologo "{0}" "{1}" "{2}"' -f $hidden,$node,$watchdog) -WorkingDirectory $ToolsDir
$periodic = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)
$boot = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
$settings.RunOnlyIfIdle = $false
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
# Disable competing restarters first; never leave two supervisors active.
$disabled = @()
$registeredAt=Get-Date
try {
  foreach ($name in @('ClaudeMobile-WebServer','ClaudeMobile-WebServer-Fixed','ClaudeMobile-LineShareHealth')) {
    $old = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if ($old -and $old.State -ne 'Disabled') {
      Disable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null
      $disabled += $name
    }
  }
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($periodic,$boot) -Settings $settings -Principal $principal -Description 'Secretary HTTP watchdog: external/3939/3940, Tailscale/Funnel repair, kim-inbox escalation; every 5 minutes' -Force | Out-Null
} catch {
  foreach ($name in $disabled) { Enable-ScheduledTask -TaskName $name -ErrorAction Continue | Out-Null }
  throw
}
$registered = Get-ScheduledTask -TaskName $taskName
if ($registered.Settings.RunOnlyIfIdle -or $registered.Triggers[0].Repetition.Interval -ne 'PT5M') { throw 'Read-back of watchdog settings failed' }
# Registration alone is not success: observe a real scheduled invocation.
# This also makes watchdog-only deployment independent of the secretary UI build.
$limit=$registeredAt.AddMinutes(6)
do {
  Start-Sleep -Seconds 10
  $info=Get-ScheduledTaskInfo -TaskName $taskName
  $task=Get-ScheduledTask -TaskName $taskName
  if ($info.LastRunTime -gt $registeredAt -and $task.State -ne 'Running') { break }
} while ((Get-Date) -lt $limit)
if ($info.LastRunTime -le $registeredAt -or $info.LastTaskResult -ne 0 -or $task.State -eq 'Running') { throw 'First scheduled watchdog run was not confirmed successful' }
$state=Get-Content (Join-Path $env:USERPROFILE '.claude\secretary-uptime\state.json') -Raw | ConvertFrom-Json
if ([DateTimeOffset]::Parse($state.checkedAt).UtcDateTime -le $registeredAt.ToUniversalTime()) { throw 'Watchdog state was not refreshed by scheduled execution' }
foreach ($name in @('external','gateway','secretary')) {
  if ($state.after.$name.ok -ne $true) { throw "Scheduled watchdog did not confirm healthy HTTP: $name" }
}
[pscustomobject]@{ TaskName=$taskName; Interval='PT5M'; LastRunTime=$info.LastRunTime.ToString('o'); LastTaskResult=$info.LastTaskResult; CheckedAt=$state.checkedAt } | ConvertTo-Json
