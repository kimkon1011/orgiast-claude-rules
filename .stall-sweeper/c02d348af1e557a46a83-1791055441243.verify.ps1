$ErrorActionPreference='Stop'
$paths=@('C:\Users\uers\orgiast-main\tools\nightly-reload-vscode.ps1','C:\Users\uers\Downloads\orgiast-claude-rules\tools\nightly-reload-vscode.ps1')
Add-Type 'public static class NightlyReloadWin32 { public static uint Last; public static uint SetThreadExecutionState(uint flags) { Last=flags; return flags; } }'
foreach ($p in $paths) {
 . $p -FunctionsOnly
 if ($script:ES_CONTINUOUS_SYSTEM_AWAYMODE_REQUIRED -isnot [uint32] -or $script:ES_CONTINUOUS_SYSTEM_AWAYMODE_REQUIRED -ne 2147483713) {throw 'Wrong enable constant'}
 if ($script:ES_CONTINUOUS -isnot [uint32] -or $script:ES_CONTINUOUS -ne 2147483648) {throw 'Wrong disable constant'}
 function Write-Log($message) {throw $message}
 Enable-SleepInhibition
 if ([NightlyReloadWin32]::Last -ne 2147483713) {throw 'Wrong enable argument'}
 Disable-SleepInhibition
 if ([NightlyReloadWin32]::Last -ne 2147483648) {throw 'Wrong disable argument'}
 & {
  $warnings=[Collections.Generic.List[string]]::new()
  function Write-Log($message) {$warnings.Add($message)}
  function Initialize-WindowApi {throw 'simulated API failure'}
  Enable-SleepInhibition
  Disable-SleepInhibition
  if ($warnings.Count -ne 2) {throw 'Missing warnings'}
  foreach ($w in $warnings) {if ($w -notlike 'WARN:*simulated API failure*') {throw 'Wrong warning'}}
 }
 Write-Output ('PASS: UInt32 constants, typed API arguments, warn-and-continue; '+$p)
}
Write-Output ('PowerShell '+$PSVersionTable.PSVersion)
