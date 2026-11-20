param([Parameter(Mandatory=$true)][ValidateSet('gateway','secretary')][string]$Service,[switch]$InspectOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'secretary-legacy-task.ps1')
. (Join-Path $PSScriptRoot 'secretary-server-process.ps1')
$bindAddress = '127.0.0.1'
if ($Service -eq 'gateway') {
  $legacy = Get-ScheduledTask -TaskName 'ClaudeMobile-WebServer' -ErrorAction SilentlyContinue
  if ($legacy -and $legacy.State -ne 'Disabled') {
    if (!(Test-SafeLegacyGateway -TaskXml ([xml](Export-ScheduledTask -TaskName 'ClaudeMobile-WebServer')))) { throw 'Unverified legacy gateway starter is enabled' }
    # Match its exact bind address: the OS admits one listener, including a startup race.
    $bindAddress = '0.0.0.0'
  }
}
$port = if ($Service -eq 'gateway') { 3939 } else { 3940 }
$folder = if ($Service -eq 'gateway') { 'claude-mobile' } else { 'secretary-pc' }
$serverDir = Join-Path $env:USERPROFILE "Downloads\$folder"
$next = Join-Path $serverDir 'node_modules\next\dist\bin\next'
$node = Join-Path $env:ProgramFiles 'nodejs\node.exe'
if (!(Test-Path -LiteralPath $next)) { throw "Missing Next executable: $next" }
$dist = '.next-production'
if (!(Test-Path -LiteralPath (Join-Path $serverDir "$dist\BUILD_ID"))) {
  if ($Service -eq 'gateway') { throw 'Gateway production build is missing' }
  $dist = '.next'
  if (!(Test-Path -LiteralPath (Join-Path $serverDir "$dist\BUILD_ID"))) { throw 'Secretary production build is missing' }
}
if ($Service -eq 'gateway') {
  $tokenFile = Join-Path $env:USERPROFILE 'Downloads\secretary-pc\.access-token'
  if (!(Test-Path -LiteralPath $tokenFile)) { throw 'Secretary access-token file is missing' }
  $secretaryToken = (Get-Content -LiteralPath $tokenFile -Raw).Trim()
  if (!$secretaryToken) { throw 'Secretary access-token is empty' }
}
$server = Get-SecretaryServer -ServerDir $serverDir -Port $port
$matching = $server.Processes
if ($InspectOnly) { [pscustomobject]@{ Service=$Service; Port=$port; Dist=$dist; BindAddress=$bindAddress; ProcessIds=@($matching.ProcessId); Listening=$server.Listening } | ConvertTo-Json; exit 0 }
foreach ($serverProcess in $matching) { Stop-Process -Id $serverProcess.ProcessId -Force -ErrorAction Stop }
if ($matching.Count) { Start-Sleep -Seconds 2 }
$logDir = Join-Path $env:USERPROFILE '.claude\secretary-uptime'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$env:NODE_ENV = 'production'
$env:SECRETARY_NEXT_DIST_DIR = $dist
if ($Service -eq 'gateway') {
  # A stale inherited override otherwise makes every private secretary API return 401.
  $env:SECRETARY_TOKEN = $secretaryToken
}
$suffix = Get-Date -Format 'yyyyMMdd-HHmmss'
$started = Start-Process -FilePath $node -ArgumentList @(('"{0}"' -f $next),'start','-H',$bindAddress,'-p',"$port") -WorkingDirectory $serverDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logDir "$Service-$suffix.out.log") -RedirectStandardError (Join-Path $logDir "$Service-$suffix.err.log") -PassThru
Write-Output "$Service started pid=$($started.Id) dist=$dist port=$port"
