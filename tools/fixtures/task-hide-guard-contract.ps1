# Isolated PS5.1 contract test: mock the Task Scheduler boundary, never live tasks.
param([Parameter(Mandatory=$true)][string]$TestHome)
$ErrorActionPreference = 'Stop'
# Load constructors before defining mocks: module autoload can replace local functions.
Import-Module ScheduledTasks, Microsoft.PowerShell.Management, Microsoft.PowerShell.Utility, Microsoft.PowerShell.Security
$PSModuleAutoLoadingPreference = 'None'
$env:USERPROFILE = $TestHome
$contractTools = Split-Path $PSScriptRoot
New-Item -ItemType Directory -Path (Join-Path $TestHome '.claude') -Force | Out-Null
Set-Content (Join-Path $TestHome '.claude\task-hide-guard.exclude.txt') "# GUI`nGui # keep visible" -Encoding UTF8
function Assert($ok, $message) { if (-not $ok) { throw $message } }
function Action($exe, $arguments='') { [pscustomobject]@{Execute=$exe;Arguments=$arguments;WorkingDirectory='C:\Work Space'} }
function Task($name, $actions, $path='\', $state='Ready') { [pscustomobject]@{TaskName=$name;TaskPath=$path;State=$state;Actions=@($actions)} }
$global:contractTasks = @(
  (Task 'ClaudeDirect' @((Action 'node.exe' '"C:\Work Space\job.mjs"'), (Action 'notepad.exe'))),
  (Task 'Gui' (Action 'cmd.exe')),
  (Task 'Admin' (Action 'powershell.exe')),
  (Task 'System' (Action 'cmd.exe') '\Microsoft\Windows\'),
  (Task 'Off' (Action 'cmd.exe') '\' 'Disabled'),
  (Task 'Hidden' (Action 'wscript.exe' '"run-hidden.vbs"'))
)
$global:contractSets = @()
function Get-ScheduledTask($TaskName, $TaskPath) { if ($TaskName) { $global:contractTasks | Where-Object TaskName -eq $TaskName } else { $global:contractTasks } }
function New-ScheduledTaskAction($Execute, $Argument, $WorkingDirectory) { [pscustomobject]@{Execute=$Execute;Arguments=$Argument;WorkingDirectory=$WorkingDirectory} }
function Set-ScheduledTask($TaskName, $TaskPath, $Action, $ErrorAction) {
  $global:contractSets += $TaskName
  if ($TaskName -eq 'Admin') { throw 'Access denied' }
  ($global:contractTasks | Where-Object TaskName -eq $TaskName).Actions = $Action
}
$output = @(& (Join-Path $contractTools 'task-hide-guard.ps1'))
Assert ($output[0] -match 'start') 'missing start'
Assert ($output[-1] -match 'done wrapped=1 skipped=3') ('incorrect summary: ' + ($output -join '; '))
Assert (($output -join "`n") -match 'EXCLUDED \\Gui') 'exclusion lost'
Assert (($output -join "`n") -match 'SKIP \\Admin') 'access denial not reported'
Assert (($global:contractSets -join ',') -eq 'ClaudeDirect,Admin') 'unexpected task modified'
$a=$global:contractTasks[0].Actions
Assert ($a.Count -eq 2 -and $a[1].Execute -eq 'notepad.exe') 'mixed actions not preserved'
Assert ($a[0].WorkingDirectory -eq 'C:\Work Space') 'working directory lost'
Assert ($a[0].Arguments.EndsWith('"node.exe" "C:\Work Space\job.mjs"')) 'quoted arguments lost'
$vbs=Join-Path $TestHome '.claude\tools\run-hidden.vbs'
Assert ((Get-FileHash $vbs).Hash -eq (Get-FileHash (Join-Path $contractTools 'run-hidden.vbs')).Hash) 'runner not deployed'
$stamp=(Get-Item $vbs).LastWriteTimeUtc
$output=@(& (Join-Path $contractTools 'task-hide-guard.ps1'))
Assert ($output[-1] -match 'done wrapped=0') 'guard not idempotent'
Assert ((Get-Item $vbs).LastWriteTimeUtc -eq $stamp) 'identical runner rewritten'
Set-Content $vbs 'stale'
$output=@(& (Join-Path $contractTools 'task-hide-guard.ps1'))
Assert ((Get-FileHash $vbs).Hash -eq (Get-FileHash (Join-Path $contractTools 'run-hidden.vbs')).Hash) 'stale runner not replaced'

# Exercise registration with real trigger/settings constructors but mocked writes.
$env:ORGIAST_NIGHTLY_REPO = Join-Path $TestHome 'stable'
New-Item -ItemType Directory -Path (Join-Path $env:ORGIAST_NIGHTLY_REPO 'tools') -Force | Out-Null
Set-Content (Join-Path $env:ORGIAST_NIGHTLY_REPO 'tools\task-hide-guard.ps1') '# fixture'
$global:contractRegistered=@(); $global:contractStarted=@()
function Register-ScheduledTask($TaskName, $Action, $Trigger, $Settings, $Principal, [switch]$Force) {
  $global:contractRegistered += [pscustomobject]@{Name=$TaskName;Action=$Action;Trigger=$Trigger;Settings=$Settings;Principal=$Principal}
}
function Start-ScheduledTask($TaskName) { $global:contractStarted += $TaskName }
& (Join-Path $contractTools 'register-task-hide-guard.ps1')
Assert ($global:contractRegistered.Count -eq 2) ('registration count: ' + $global:contractRegistered.Count + ' started=' + $global:contractStarted.Count)
$guard=$global:contractRegistered[0]; $watch=$global:contractRegistered[1]
Assert ($guard.Action.Execute -match 'wscript.exe$') 'visible action'
Assert ($guard.Action.Arguments.Contains($env:ORGIAST_NIGHTLY_REPO)) 'stable path not used'
Assert ($guard.Trigger.Count -eq 2 -and $guard.Trigger[0].Delay -eq 'PT1M' -and $guard.Trigger[1].Repetition.Interval -eq 'PT30M') 'guard triggers'
Assert ($guard.Settings.ExecutionTimeLimit -eq 'PT10M') 'guard timeout'
Assert ($watch.Settings.ExecutionTimeLimit -eq 'PT0S') 'watch timeout'
Assert ($watch.Settings.MultipleInstances -eq 2) 'watch overlapping'
Assert ($guard.Principal.LogonType -eq 3 -and $guard.Principal.RunLevel -eq 0) 'principal'
Assert (($global:contractStarted -join ',') -eq 'Claude-TaskHideGuard') 'startup must not restart watcher'
'PASS: guard exclusion, wrapping, access denial, SHA256, idempotency; stable registration, triggers and settings'
