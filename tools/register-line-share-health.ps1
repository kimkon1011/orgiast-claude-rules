param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'ClaudeMobile-LineShareHealth'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; exit }
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$toolsDir = Resolve-RegisterToolsDir -Fallback $PSScriptRoot -RequiredLeaves @('line-share-health.mjs', 'line-export-reminder.mjs', 'is-entry.mjs')
$script = Join-Path $toolsDir 'line-share-health.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
if (!(Test-Path $script) -or !(Test-Path $hidden)) { throw 'Health script or run-hidden.vbs missing' }
$arguments = '"{0}" "{1}" "{2}"' -f $hidden,$node,$script
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument $arguments -WorkingDirectory (Split-Path $toolsDir)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -Priority 4 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Hourly Funnel LINE share checks, 6-hour alert/recovery cooldown.' -Force | Out-Null
Get-ScheduledTask -TaskName $name | Select-Object TaskName,State,Actions,Triggers | Format-List
