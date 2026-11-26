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
# Keep the waiting launcher outside the repository being updated.
$launcher = Join-Path $env:USERPROFILE '.claude\tools\wait-for-script.mjs'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $launcher) | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'tools\lib\wait-for-script.mjs') -Destination $launcher -Force
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($launcher, $script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '05:50'
$settings = New-ScheduledTaskSettingsSet -Priority 4 -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30)
Register-ScheduledTask -TaskName 'OrgiastKimEditorSweep' -Action $action -Trigger $trigger -Settings $settings -Description 'Ensure kim editor permission on automation files from the last seven days.' -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'OrgiastKimEditorSweep' -ErrorAction Stop
if (-not $task.Actions.Arguments.Contains($script) -or -not $task.Actions.Arguments.Contains($launcher) -or $task.Triggers[0].StartBoundary.Substring(11,5) -ne '05:50') { throw 'read-back failed: OrgiastKimEditorSweep' }
Write-Host 'OK: OrgiastKimEditorSweep daily 05:50'
