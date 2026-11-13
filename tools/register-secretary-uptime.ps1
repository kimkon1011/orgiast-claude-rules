param([string]$ToolsDir=$PSScriptRoot)
$ErrorActionPreference = 'Stop'
$watchdog = Join-Path $ToolsDir 'secretary-uptime.mjs'
$hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
foreach ($required in @($watchdog,$hidden,(Join-Path $ToolsDir 'secretary-restart.ps1'),(Join-Path $ToolsDir 'kim-inbox.mjs'))) {
  if (!(Test-Path -LiteralPath $required)) { throw "Missing dependency: $required" }
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
Get-ScheduledTaskInfo -TaskName $taskName | Select-Object TaskName,LastRunTime,LastTaskResult,NextRunTime
