# Register morning inbox batch as a hidden daily task at 07:00.
# Run: powershell -ExecutionPolicy Bypass -File "<this file>"
# ASCII only: Windows PowerShell 5.1 may parse BOM-less UTF-8 as Shift-JIS.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$script = Join-Path $repo 'tools\morning-batch.mjs'
if (-not (Test-Path $script)) { throw "script not found: $script" }
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }
$hiddenRunner = Join-Path $repo 'tools\run-hidden.vbs'
if (-not (Test-Path $hiddenRunner)) { throw "hidden runner not found: $hiddenRunner" }
$argument = '//nologo "{0}" "{1}" "{2}"' -f $hiddenRunner, $node, $script
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\wscript.exe" -Argument $argument -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At 7:00am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
Register-ScheduledTask -TaskName 'OrgiastMorningBatch' -Action $action -Trigger $trigger -Settings $settings -Description 'Collect Discord inbox into the morning batch (daily 07:00)' -Force | Out-Null
Write-Host 'OK: task OrgiastMorningBatch registered (daily 07:00)'
Get-ScheduledTask -TaskName 'OrgiastMorningBatch' | Select-Object TaskName, State
