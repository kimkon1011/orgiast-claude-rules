# Launch only the desktop app; never type, paste, or press Enter.
function Wait-DiscordWindow {
 param(
  [Parameter(Mandatory=$true)][scriptblock]$FindWindow,
  [scriptblock]$IsRunning = { @(Get-Process -Name Discord -ErrorAction SilentlyContinue).Count -gt 0 },
  [scriptblock]$StartDiscord = {
   $updater = Join-Path $env:LOCALAPPDATA 'Discord\Update.exe'
   if (-not (Test-Path -LiteralPath $updater)) { throw 'Discord Update.exe not found' }
   Start-Process -FilePath $updater -ArgumentList @('--processStart', 'Discord.exe') | Out-Null
  },
  [scriptblock]$Delay = { Start-Sleep -Milliseconds 500 },
  [int]$Attempts = 60
 )
 $window = & $FindWindow
 if ($window) { return $window }
 if (-not (& $IsRunning)) { & $StartDiscord | Out-Null }
 for ($attempt = 0; $attempt -lt $Attempts; $attempt++) {
  & $Delay | Out-Null
  $window = & $FindWindow
  if ($window) { return $window }
 }
 throw 'Discord window not found after startup wait'
}
