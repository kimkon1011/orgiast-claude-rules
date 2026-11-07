try {
  Start-ScheduledTask -TaskName 'OrgiastNightlyHealth' -ErrorAction Stop
  Write-Output "started"
} catch {
  Write-Output "error: $($_.Exception.Message)"
}