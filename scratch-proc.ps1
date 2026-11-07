try {
  $procs = Get-Process -Name 'node','wscript','wscript.exe' -ErrorAction SilentlyContinue
  if ($procs) {
    foreach ($p in $procs) {
      Write-Output "$($p.Name) PID=$($p.ProcessId) CPU=$($p.CPUPerc)% Mem=$($p.WorkingSetSize / 1MB) MB Started=$($p.CreateDate)"
    }
  } else {
    Write-Output "no matching processes"
  }
} catch {
  Write-Output "error: $($_.Exception.Message)"
}
try {
  $tasks = Get-ScheduledTask -TaskName 'OrgiastNightlyHealth' -ErrorAction Stop
  $info = Get-ScheduledTaskInfo -TaskName 'OrgiastNightlyHealth' -ErrorAction Stop
  Write-Output "Task: State=$($tasks.State) LastResult=$($info.LastTaskResult) LastRun=$($info.LastRunTime.ToString('o'))"
} catch {
  Write-Output "task error: $($_.Exception.Message)"
}