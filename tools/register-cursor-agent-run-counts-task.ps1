# Cursor delegation was disabled on 2026-11-25 because its usage is billed as an extra charge (kim instruction).
# Keep this file only as a converge cleanup for the legacy scheduled task.
# Run: powershell -ExecutionPolicy Bypass -File "<this file>"
# ASCII only: Windows PowerShell 5.1 may parse BOM-less UTF-8 as Shift-JIS.
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastCursorAgentRunCounts'
if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Write-Host 'OK: legacy Cursor agent counter task is disabled'
