Get-ScheduledTask | Where-Object {$_.TaskName -like 'Orgiast*'} | ForEach-Object {
  $i = Get-ScheduledTaskInfo $_
  "$($_.TaskName)`t$($_.State)`t$($i.LastTaskResult)`t$($i.LastRunTime)"
}