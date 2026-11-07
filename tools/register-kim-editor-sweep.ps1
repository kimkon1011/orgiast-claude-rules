# All PCs: kim editor permission sweep, daily 05:50. Registration through setup manifest.
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\kim-editor-sweep.mjs')
$script = Join-Path $repo 'tools\kim-editor-sweep.mjs'
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
if ($ValidateOnly) {
  & $node --check $script
  if ($LASTEXITCODE -ne 0) { throw 'syntax check failed' }
  return
}
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '05:50'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'OrgiastKimEditorSweep' -Action $action -Trigger $trigger -Settings $settings -Description 'Ensure kim editor permission on automation files from the last seven days.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'OrgiastKimEditorSweep' -ErrorAction Stop
if (-not $task.Actions.Arguments.Contains($script) -or $task.Triggers[0].StartBoundary.Substring(11,5) -ne '05:50') { throw 'read-back failed: OrgiastKimEditorSweep' }
Write-Host 'OK: OrgiastKimEditorSweep daily 05:50'
