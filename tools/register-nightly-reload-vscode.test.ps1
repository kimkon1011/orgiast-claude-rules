$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'register-nightly-reload-vscode.ps1') -FunctionsOnly
function Assert($Condition, $Message) { if (-not $Condition) { throw "FAIL: $Message" } }
# Real CIM task constructors, in-memory scheduler: never register or start a real task.
$script:storedTask = $null
$script:registrations = 0
function Get-ScheduledTask { param($TaskPath, $TaskName); return $script:storedTask }
function Register-ScheduledTask {
    param($TaskName, $TaskPath, $InputObject, [switch]$Force)
    $script:registrations++
    $script:storedTask = $InputObject
    $script:storedTask.TaskName = $TaskName
}
$result = Register-NightlyReloadTask
Assert ($result.changed -and $script:registrations -eq 1) 'missing task is registered once'
Assert (@($script:storedTask.Triggers).Count -eq 5) 'five daily triggers'
$times = @($script:storedTask.Triggers | ForEach-Object { ([datetime]$_.StartBoundary).ToString('HH:mm') } | Sort-Object)
Assert (($times -join ',') -eq '04:40,05:00,05:20,05:40,06:00') 'night schedule'
$result = Register-NightlyReloadTask
Assert (-not $result.changed -and $script:registrations -eq 1) 'identical task is not rewritten'
$script:storedTask.Settings.Enabled = $false
$result = Register-NightlyReloadTask
Assert ($result.changed -and $script:registrations -eq 2) 'disabled task repaired'
$script:storedTask.Actions[0].Arguments = '-File old.ps1'
$result = Register-NightlyReloadTask
Assert ($result.changed -and $script:registrations -eq 3) 'stale script path repaired'
$script:storedTask.Triggers[0].StartBoundary = '2020-01-01T12:00:00'
$result = Register-NightlyReloadTask
Assert ($result.changed -and $script:registrations -eq 4) 'schedule drift repaired'
function Get-ScheduledTask { param($TaskPath, $TaskName); throw 'access denied' }
$failed = $false
try { Register-NightlyReloadTask } catch { $failed = $true }
Assert ($failed -and $script:registrations -eq 4) 'query failure is not treated as absence'
Write-Output 'PASS: nightly task registration (7 cases)'
