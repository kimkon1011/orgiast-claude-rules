$env:CLAUDE_BACKUP_LOCAL_DIR = 'Z:\nope'
Write-Host "=== Starting backup test (non-existent drive Z:\) ==="
& "C:\Users\kimko\.claude\nightly-repo\tools\backup-claude-to-drive.ps1"
$exitCode = $LASTEXITCODE
Write-Host "EXIT CODE: $exitCode"
if ($exitCode -eq 1) {
  Write-Host "*** TEST PASSED: exit code 1 (expected failure) ***"
} else {
  Write-Host "*** TEST UNEXPECTED: exit code $exitCode ***"
}
