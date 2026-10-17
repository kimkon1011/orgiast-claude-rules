# kim-PC only. No task is started immediately by registration.
$ErrorActionPreference = 'Stop'
$labelFile = Join-Path $env:USERPROFILE '.claude\cost-reporter.env'
if (-not (Test-Path $labelFile) -or -not ((Get-Content $labelFile) -match '^REPORTER_LABEL=["'']?kim-PC["'']?\s*$')) { Write-Output 'SKIP: kim-PC only'; exit }
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @((Join-Path $PSScriptRoot 'discord-dm-drafts.mjs'), 'scan') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) -RepetitionInterval (New-TimeSpan -Minutes 15)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 14) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'OrgiastDiscordDmDrafts' -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Prepare Discord DM reply drafts when idle; never auto-send' -Force | Out-Null
Write-Output 'OK: OrgiastDiscordDmDrafts registered (15 minutes)'
