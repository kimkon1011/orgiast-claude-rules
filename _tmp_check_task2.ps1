$task = Get-ScheduledTask -TaskName 'OrgiastWindowSpawnWatch'

Write-Output "=== FULL TASK DUMP ==="

# Get the action
$act = $task.Action
Write-Output "Action type: $($act.Class)"

# Show methods/properties
Write-Output "--- Action Members ---"
$act | Get-Member | ForEach-Object { Write-Output "$($_.Name) ($($_.Kind))" }

Write-Output "--- Action details ---"
$act | Format-List -Force

Write-Output "--- Trigger details ---"
$task.Triggers | ForEach-Object { Write-Output "==="; $_ | Format-List -Force }

Write-Output "--- Settings ---"
$task.Settings | Format-List -Force