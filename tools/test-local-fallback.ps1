$tempDir = Join-Path $env:TEMP ('claude-backup-test-' + (Get-Random))
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
Write-Host "TEMP BACKUP DIR: $tempDir"

$env:CLAUDE_BACKUP_LOCAL_DIR = $tempDir
Write-Host "=== Starting backup test (local fallback) ==="

& "C:\Users\kimko\.claude\nightly-repo\tools\backup-claude-to-drive.ps1"
$exitCode = $LASTEXITCODE
Write-Host "EXIT CODE: $exitCode"

Write-Host "=== Listing backup dir ==="
Get-ChildItem -Path $tempDir -Recurse

Write-Host "=== Cleanup ==="
Remove-Item -Path $tempDir -Recurse -Force

if ($exitCode -eq 0) {
  Write-Host "*** TEST PASSED: exit code 0 ***"
} else {
  Write-Host "*** TEST FAILED: exit code $exitCode ***"
}
