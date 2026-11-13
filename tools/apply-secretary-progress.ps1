$ErrorActionPreference='Stop'
$AppDir=Join-Path $env:USERPROFILE 'Downloads\secretary-pc'
# Run only from a session allowed to write AppDir and the user's .claude directory.
# No elevation or sandbox bypass is attempted by this installer.
if ($env:COMPUTERNAME -ne 'DESKTOP-2D0R4LI') { throw 'This deployment is scoped to kim-PC / DESKTOP-2D0R4LI' }
$payload=Join-Path $PSScriptRoot 'secretary-progress'
$manifest=Get-Content (Join-Path $payload 'manifest.json') -Raw | ConvertFrom-Json
foreach ($entry in $manifest.files) {
  $destination=Join-Path $AppDir $entry.path
  $current=if (Test-Path -LiteralPath $destination) { (Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLower() } else { $null }
  if ($current -ne $entry.before -and $current -ne $entry.after) { throw "Changed since review; refusing overwrite: $($entry.path)" }
}
$backup=Join-Path $env:USERPROFILE ('.claude\secretary-uptime\backup-'+(Get-Date -Format yyyyMMdd-HHmmss))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($entry in $manifest.files) {
  $destination=Join-Path $AppDir $entry.path
  if (Test-Path -LiteralPath $destination) {
    $saved=Join-Path $backup $entry.path
    New-Item -ItemType Directory -Path (Split-Path $saved -Parent) -Force | Out-Null
    Copy-Item -LiteralPath $destination -Destination $saved
  }
  New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $payload $entry.path) -Destination $destination
  if ((Get-FileHash -LiteralPath $destination -Algorithm SHA256).Hash.ToLower() -ne $entry.after) { throw "Read-back mismatch: $($entry.path)" }
}
$node=Join-Path $env:ProgramFiles 'nodejs\node.exe'
$buildDir='.next-uptime-'+(Get-Date -Format yyyyMMddHHmmss)
$env:SECRETARY_NEXT_DIST_DIR=$buildDir
$env:NODE_ENV='production'
Push-Location $AppDir
try {
  & $node --test tests/watches.test.mjs tests/trip.test.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Secretary tests failed; live process remains running' }
  & $node node_modules/next/dist/bin/next build
  if ($LASTEXITCODE -ne 0) { throw 'Secretary build failed; live process remains running' }
} finally { Pop-Location }
# The new build is complete before touching the currently running server.
$next=Join-Path $AppDir 'node_modules\next\dist\bin\next'
$servers=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($next) -and $_.CommandLine -match '-p\s+3940(?:\s|$)' })
foreach ($serverProcess in $servers) { Stop-Process -Id $serverProcess.ProcessId -Force }
$production=Join-Path $AppDir '.next-production'
if (Test-Path -LiteralPath $production) { Move-Item -LiteralPath $production -Destination (Join-Path $backup 'previous-production') }
Move-Item -LiteralPath (Join-Path $AppDir $buildDir) -Destination $production
& (Join-Path $PSScriptRoot 'secretary-restart.ps1') -Service secretary
if ($LASTEXITCODE -ne 0) { throw 'Secretary restart failed' }
& (Join-Path $PSScriptRoot 'secretary-restart.ps1') -Service gateway
if ($LASTEXITCODE -ne 0) { throw 'Gateway restart failed' }
& (Join-Path $PSScriptRoot 'register-secretary-uptime.ps1')
if ($LASTEXITCODE -ne 0) { throw 'Watchdog registration failed' }
# register-secretary-uptime already verifies the first real scheduled run.
$info=Get-ScheduledTaskInfo -TaskName 'OrgiastFunnelProbe'
& $node (Join-Path $PSScriptRoot 'verify-secretary-live.mjs') $manifest.requiredLabel
if ($LASTEXITCODE -ne 0) { throw 'External URL / authenticated progress display verification failed' }
[pscustomobject]@{ TaskName='OrgiastFunnelProbe'; Interval='PT5M'; LastRunTime=$info.LastRunTime.ToString('o'); LastTaskResult=$info.LastTaskResult; Backup=$backup } | ConvertTo-Json
