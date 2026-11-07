try {
  $t = Get-ScheduledTask -TaskName 'OrgiastNightlyHealth' -ErrorAction Stop
  Write-Output "State=$($t.State)"
  $i = Get-ScheduledTaskInfo -TaskName 'OrgiastNightlyHealth' -ErrorAction Stop
  Write-Output "LastRun=$($i.LastRunTime.ToString('o'))"
  Write-Output "NextRun=$($i.NextRunTime.ToString('o'))"
  Write-Output "LastResult=$($i.LastTaskResult)"
  Write-Output "Status=$($i.Status)"
} catch {
  Write-Output "error: $($_.Exception.Message)"
}