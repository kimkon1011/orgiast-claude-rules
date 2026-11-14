$ErrorActionPreference = 'Stop'
$task = Get-ScheduledTask -TaskName 'OrgiastWindowSpawnWatch' -ErrorAction SilentlyContinue
if (-not $task) { Write-Output 'TASK NOT FOUND'; exit 1 }

Write-Output "=== OrgiastWindowSpawnWatch ==="
Write-Output "State: $($task.State)"
Write-Output "Enabled: $($task.Settings.Enabled)"
Write-Output "LastRunTime: $($task.LastRunTime)"
Write-Output "LastTaskResult: $($task.LastTaskResult)"
Write-Output "NextRunTime: $($task.NextRunTime)"
Write-Output "Action: $($task.Action.Execute) $($task.Action.Arguments)"
Write-Output "TimeLimit: $($task.Settings.ExecutionTimeLimit)"

foreach ($t in $task.Triggers) {
    Write-Output "Trigger: Type=$($t.TriggerType)"
}