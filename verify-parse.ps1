$file = 'D:\wt-backup-staging\tools\backup-claude-to-drive.ps1'
$c = Get-Content $file -Raw
$tok = $null; $err = $null
$ast = [System.Management.Automation.Language.Parser]::ParseInput($c, [ref]$tok, [ref]$err)
if ($err.Count -gt 0) {
    foreach ($e in $err) {
        Write-Host ('PARSE ERROR: line {0} col {1}: {2}' -f $e.Extent.StartLineNumber, $e.Extent.StartColumnNumber, $e.Message)
    }
    exit 1
}
Write-Host 'PARSE OK: syntax is valid'
exit 0