param([switch]$Remove)
$ErrorActionPreference='Stop';$name='AI'+[char]0x4ee3+[char]0x884c+[char]0x5802+'LINE'+[char]0x76e3+[char]0x8996
if($Remove){Unregister-ScheduledTask -TaskName $name -Confirm:$false;exit}
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$toolsDir=Resolve-RegisterToolsDir -Fallback $PSScriptRoot -RequiredLeaves @('ai-daikodo-line-watch.mjs','is-entry.mjs')
$node=(Get-Command node.exe -ErrorAction Stop).Source;$hidden=Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
if(!(Test-Path $hidden)){throw 'run-hidden.vbs missing'}
$action=New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('"{0}" "{1}" "{2}"'-f $hidden,$node,(Join-Path $toolsDir 'ai-daikodo-line-watch.mjs')) -WorkingDirectory (Split-Path $toolsDir)
$trigger=New-ScheduledTaskTrigger -Once -At ((Get-Date).Date.AddHours((Get-Date).Hour+1)) -RepetitionInterval (New-TimeSpan -Hours 1)
$settings=New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -Hidden
$principal=New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Hourly AI Daikodo LINE inbox draft queue' -Force|Out-Null
Get-ScheduledTask -TaskName $name|Select-Object TaskName,State|Format-List
