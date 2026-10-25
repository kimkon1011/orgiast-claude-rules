param([switch]$Remove)
$ErrorActionPreference = 'Stop'
$name = 'ClaudeMobile-LineShareHealth'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; exit }
$script = Join-Path $PSScriptRoot 'line-share-health.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
if (!(Test-Path $script) -or !(Test-Path $hidden)) { throw 'Health script or run-hidden.vbs missing' }
$arguments = '"{0}" "{1}" "{2}"' -f $hidden,$node,$script
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument $arguments -WorkingDirectory (Split-Path $PSScriptRoot)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Hourly Funnel LINE share checks, 6-hour alert/recovery cooldown.' -Force | Out-Null
Get-ScheduledTask -TaskName $name | Select-Object TaskName,State,Actions,Triggers | Format-List
