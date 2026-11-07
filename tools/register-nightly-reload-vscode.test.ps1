$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'register-nightly-reload-vscode.ps1') -FunctionsOnly
function Assert($Condition, $Message) { if (-not $Condition) { throw "FAIL: $Message" } }
# Real CIM task constructors, in-memory scheduler injected as scriptblocks: never register or start a real task.
$script:storedTask = $null
$script:registrations = 0
$get = { param($TaskName) if ($TaskName -eq 'ClaudeNightlyReloadVSCode') { return $null }; $script:storedTask }
$register = {
    param($TaskName, $InputObject)
    $script:registrations++
    $script:storedTask = $InputObject
}
function Invoke-Register { Register-NightlyReloadTask -GetTask $get -RegisterTask $register }
$result = Invoke-Register
Assert ($result.changed -and $script:registrations -eq 1) 'missing task is registered once'
Assert (@($script:storedTask.Triggers).Count -eq 5) 'five daily triggers'
$times = @($script:storedTask.Triggers | ForEach-Object { ([datetime]$_.StartBoundary).ToString('HH:mm') } | Sort-Object)
Assert (($times -join ',') -eq '04:40,05:00,05:20,05:40,06:00') 'night schedule'
$result = Invoke-Register
Assert (-not $result.changed -and $script:registrations -eq 1) 'identical task is not rewritten'
$script:storedTask.Settings.Enabled = $false
$result = Invoke-Register
Assert ($result.changed -and $script:registrations -eq 2) 'disabled task repaired'
$script:storedTask.Actions[0].Arguments = '-File old.ps1'
$result = Invoke-Register
Assert ($result.changed -and $script:registrations -eq 3) 'stale script path repaired'
$script:storedTask.Triggers[0].StartBoundary = '2020-01-01T12:00:00'
$result = Invoke-Register
Assert ($result.changed -and $script:registrations -eq 4) 'schedule drift repaired'
$get = { param($TaskName) throw 'access denied' }
$failed = $false
try { Invoke-Register } catch { $failed = $true }
Assert ($failed -and $script:registrations -eq 4) 'query failure is not treated as absence'
Write-Output 'PASS: nightly task registration (7 cases)'

$script:legacy = [pscustomobject]@{ Settings = [pscustomobject]@{ Enabled = $true } }
$script:disabled = 0
$get = { param($TaskName) if ($TaskName -eq 'ClaudeNightlyReloadVSCode') { return $script:legacy }; $script:storedTask }
$disable = { param($TaskName) $script:disabled++; $script:legacy.Settings.Enabled = $false }
$result = Register-NightlyReloadTask -GetTask $get -RegisterTask $register -DisableTask $disable
Assert ($result.changed -and $script:disabled -eq 1) 'legacy task disabled'
$result = Register-NightlyReloadTask -GetTask $get -RegisterTask $register -DisableTask $disable
Assert (-not $result.changed -and $script:disabled -eq 1) 'legacy disable is idempotent'
Write-Output 'PASS: legacy task disabled, never deleted'
