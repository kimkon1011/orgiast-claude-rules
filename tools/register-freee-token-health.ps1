param([switch]$Remove, [string]$EnvFile = '')
$ErrorActionPreference = 'Stop'
$name = 'ClaudeFreeeTokenHealth'
if ($Remove) { Unregister-ScheduledTask -TaskName $name -Confirm:$false; exit }
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$toolsDir = Resolve-RegisterToolsDir -Fallback $PSScriptRoot -RequiredLeaves @('freee-token-health.mjs', 'kim-inbox.mjs', 'is-entry.mjs')
$script = Join-Path $toolsDir 'freee-token-health.mjs'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
if (!(Test-Path $script) -or !(Test-Path $hidden)) { throw 'Health script or run-hidden.vbs missing' }
$arguments = '"{0}" "{1}" "{2}"' -f $hidden,$node,$script
if ($EnvFile) {
  if (-not (Test-Path -LiteralPath $EnvFile -PathType Leaf)) { throw "env file not found: $EnvFile" }
  $arguments = '{0} --env-file "{1}"' -f $arguments, $EnvFile
}
$action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument $arguments -WorkingDirectory (Split-Path $toolsDir)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 6)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -Priority 4 -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'freee 認可切れを検知して kim-inbox に通知（6時間間隔）' -Force | Out-Null
Get-ScheduledTask -TaskName $name | Select-Object TaskName,State,Actions,Triggers | Format-List
