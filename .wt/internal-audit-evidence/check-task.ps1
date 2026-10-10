$parseTokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseFile('C:\Users\uers\orgiast-main\.wt\internal-audit\tools\register-internal-audit-task.ps1', [ref]$parseTokens, [ref]$parseErrors) | Out-Null
Write-Output ('PowerShell parse errors: ' + $parseErrors.Count)
if ($parseErrors.Count -gt 0) { exit 1 }
