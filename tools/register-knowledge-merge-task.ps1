# Registers the hourly knowledge-merge task (idempotent, Windows PS5.1 safe: ASCII only).
#   OrgiastKnowledgeMerge: hourly, kim-PC only -> tools/knowledge-merge.mjs
param([switch]$ValidateOnly, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastKnowledgeMerge'
if ($Unregister) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: $taskName unregistered" }
  else { Write-Host "OK: $taskName was not registered" }
  exit 0
}
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\knowledge-merge.mjs')
$script = Join-Path $repo 'tools\knowledge-merge.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw "missing: $script" }
if ($ValidateOnly) {
  $node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
  if (-not $node) { throw 'node.exe not found' }
  & $node --check $script
  if ($LASTEXITCODE -ne 0) { throw "node --check failed: $script" }
  Write-Host 'validate only: OK (no registration)'
  return
}
$node = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $node) { throw 'node.exe not found' }
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
# Run every hour at :42 to spread load vs other hourly tasks
$trigger = New-ScheduledTaskTrigger -Daily -At '00:42'
$trigger.RepetitionInterval = (New-TimeSpan -Hours 1)
$trigger.RepetitionDuration = (New-TimeSpan -Days 365)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description '(kim-PC only) Merge inbox knowledge to Drive master hourly' -Force | Out-Null
Write-Host "OK: task $taskName registered (hourly at :42, limit 15 min)"
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
$registered | Select-Object TaskName, State
$registered.Actions | Select-Object Execute, Arguments, WorkingDirectory