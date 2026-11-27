$ErrorActionPreference = 'Stop'
$taskName = 'Orgiast-ReplyNotify'
$scriptPath = Join-Path $PSScriptRoot 'reply-notify.mjs'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$arguments = "-NoProfile -NonInteractive -WindowStyle Hidden -Command `"& '$nodePath' '$scriptPath'`""
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -StartWhenAvailable
$principal = New-ScheduledTaskPrincipal -UserId ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Notify an internal owner when watched customer replies arrive.' -Force | Out-Null
Write-Output "Registered $taskName every 15 minutes: $scriptPath"
