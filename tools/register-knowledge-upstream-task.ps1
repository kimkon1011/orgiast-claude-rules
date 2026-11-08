# Registers the hourly knowledge-upstream + knowledge-sync-down task (idempotent, Windows PS5.1 safe: ASCII only).
#   OrgiastKnowledgeUpstream: hourly, all PCs -> tools/knowledge-upstream.mjs
param([switch]$ValidateOnly, [switch]$Unregister)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastKnowledgeUpstream'
if ($Unregister) {
  if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: $taskName unregistered" }
  else { Write-Host "OK: $taskName was not registered" }
  exit 0
}
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\knowledge-upstream.mjs', 'tools\memory-share.mjs')
$script = Join-Path $repo 'tools\knowledge-upstream.mjs'
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
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--sync-down') -WorkingDirectory $repo
# Run every hour at :17 to spread load vs other hourly tasks
$next = (Get-Date).Date.AddHours((Get-Date).Hour).AddMinutes(17)
if ($next -le (Get-Date)) { $next = $next.AddHours(1) }
$trigger = New-ScheduledTaskTrigger -Once -At $next -RepetitionInterval (New-TimeSpan -Hours 1)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
try {
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Auto-send local memory/playbook/incident knowledge to Drive inbox and sync Drive master knowledge down (hourly, all PCs)' -Force | Out-Null
} catch {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Auto-send local memory/playbook/incident knowledge to Drive inbox and sync Drive master knowledge down (hourly, all PCs)' -Force | Out-Null
}
Write-Host "OK: task $taskName registered (hourly at :17, limit 15 min)"
$registered = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
if ($registered.Triggers[0].Repetition.Interval -ne 'PT1H') {
  Write-Error "Task $taskName read-back failed: Repetition.Interval is '$($registered.Triggers[0].Repetition.Interval)', expected 'PT1H'"
  exit 1
}
$registered | Select-Object TaskName, State
$registered.Actions | Select-Object Execute, Arguments, WorkingDirectory