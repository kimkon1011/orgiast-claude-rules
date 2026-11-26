# Register the unsent mail ledger reconciliation at minute 25 every hour.
param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastUnsentLedger'
if ($Unregister) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue; exit 0 }
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\unsent-ledger-runner.mjs','tools\nightly-bootstrap.ps1')
$bootstrapDir = Join-Path $env:USERPROFILE '.claude\tools'; New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
$bootstrap = Join-Path $bootstrapDir 'nightly-bootstrap.ps1'; Copy-Item -LiteralPath (Join-Path $repo 'tools\nightly-bootstrap.ps1') -Destination $bootstrap -Force
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$bootstrap,'-Target','tools\unsent-ledger-runner.mjs') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At '00:25' -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Capture Discord appointments and reconcile unsent mail hourly at :25' -Force | Out-Null
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName,State
