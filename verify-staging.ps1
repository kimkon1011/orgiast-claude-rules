$ErrorActionPreference = 'Stop'

# 1. Parse check
$scriptPath = 'D:\wt-backup-staging\tools\backup-claude-to-drive.ps1'
$errors = $null
$tokens = $null
[System.Management.Automation.Language.Parser]::ParseFile($scriptPath, [ref]$tokens, [ref]$errors)
$parseErrors = @($errors | Where-Object { $_.ErrorId -ne 'PositionalExpressionNeedsSubExpression' })
if ($parseErrors.Count -gt 0) {
    Write-Host "parse FAILED: $($parseErrors.Count) errors"
    foreach ($e in $parseErrors) { Write-Host "  $($e.Message) at line $($e.Extent.StartLineNumber)" }
    exit 1
}
Write-Host "parse OK"

# 2. Record log line count before
$logFile = "$env:USERPROFILE\.claude\logs\backup-to-drive.log"
$beforeLines = 0
if (Test-Path $logFile) { $beforeLines = (Get-Content $logFile).Count }

# 3. Run DryRun, capture stdout to temp file
$tempOut = [IO.Path]::GetTempFileName() + ".txt"
try {
    $process = Start-Process -FilePath powershell -ArgumentList @('-NoProfile', '-File', "D:\wt-backup-staging\tools\backup-claude-to-drive.ps1", '-DryRun') -NoNewWindow -RedirectStandardOutput $tempOut -RedirectStandardError "$tempOut.err" -PassThru -Wait
    if ($process.ExitCode -ne 0) {
        Write-Host "DryRun FAILED exit=$($process.ExitCode)"
        if (Test-Path "$tempOut.err") { Get-Content "$tempOut.err" }
        exit 1
    }
} catch {
    Write-Host "DryRun execution FAILED: $_"
    if (Test-Path $tempOut) { Get-Content $tempOut }
    exit 1
}

# 4. Show incremental log lines
Write-Host ""
Write-Host "=== DryRun log (incremental) ==="
$logIncrement = @()
if (Test-Path $logFile) {
    $afterLines = (Get-Content $logFile).Count
    $increment = $afterLines - $beforeLines
    if ($increment -gt 0) {
        $logIncrement = Get-Content $logFile | Select-Object -Last $increment
    }
}
if ($logIncrement.Count -eq 0) {
    Write-Host "(no new log lines)"
}
foreach ($line in $logIncrement) { Write-Host $line }

Write-Host ""
Write-Host "=== Stdout plan lines ==="
$stdout = Get-Content $tempOut -Raw
$planLines = @($stdout -split "`n" | Where-Object { $_ -match 'plan ' })
foreach ($line in $planLines) { Write-Host $line }

# Cleanup
if (Test-Path $tempOut) { Remove-Item $tempOut -Force }
if (Test-Path "$tempOut.err") { Remove-Item "$tempOut.err" -Force }
