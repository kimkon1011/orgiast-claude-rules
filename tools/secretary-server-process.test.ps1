$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'secretary-server-process.ps1')

function Get-CimInstance {
  param($ClassName,$Filter)
  if ($ClassName -ne 'Win32_Process' -or $Filter -ne "Name='node.exe'") { throw 'Unexpected CIM process query' }
  return $script:processes
}

function Get-NetTCPConnection {
  param($State,$LocalPort,$ErrorAction)
  if ($State -ne 'Listen' -or $LocalPort -ne $script:port) { throw 'Unexpected listener query' }
  foreach ($owner in $script:owners) { [pscustomobject]@{ OwningProcess = $owner } }
}

function New-TestProcess($Id,$Command,$ParentId=0,$StartedAt=[datetime]'2026-11-18T19:45:00') {
  return [pscustomobject]@{ ProcessId = $Id; CommandLine = $Command; ParentProcessId = $ParentId; CreationDate = $StartedAt }
}

function Assert-ServerProcessIds([int[]]$Expected) {
  $server = Get-SecretaryServer -ServerDir $script:serverDir -Port $script:port
  $actual = @($server.Processes | ForEach-Object { $_.ProcessId })
  if (($actual -join ',') -ne ($Expected -join ',') -or $server.Listening -ne ($script:owners.Count -gt 0)) {
    throw "Expected [$($Expected -join ',')], got [$($actual -join ',')], listening=$($server.Listening)"
  }
}

function Assert-RejectedListener {
  try {
    $null = Get-SecretaryServer -ServerDir $script:serverDir -Port $script:port
  } catch {
    if ($_.Exception.Message -ne "Port $script:port is owned by an unexpected process; refused to terminate it") { throw }
    return
  }
  throw 'Accepted an unexpected listener'
}

$serverDir = 'C:\Users\uers\Downloads\claude-mobile'
$port = 3939
$gateway = New-TestProcess 101 '"C:\Program Files\nodejs\node.exe"  "C:\Users\uers\Downloads\claude-mobile\node_modules\next\dist\bin\next" "start" "-H" "0.0.0.0" "-p" "3939"'
$processes = @(
  $gateway
  (New-TestProcess 102 'node.exe C:\Users\uers\Downloads\claude-mobile-copy\node_modules\next\dist\bin\next start -p 3939')
  (New-TestProcess 103 'node.exe C:\Users\uers\Downloads\claude-mobile\node_modules\next\dist\bin\next-copy start -p 3939')
  (New-TestProcess 104 'node.exe C:\Users\uers\Downloads\claude-mobile\node_modules\next\dist\bin\next start --other "text -p 3939 text"')
  (New-TestProcess 105 'node.exe C:\other\server.js C:\Users\uers\Downloads\claude-mobile\node_modules\next\dist\bin\next start -p 3939')
  (New-TestProcess 106 'node.exe C:\Users\uers\Downloads\claude-mobile\node_modules\next\dist\bin\next start -p 39390')
  (New-TestProcess 0 $gateway.CommandLine)
)
$owners = @(101,101)
Assert-ServerProcessIds @(101)
foreach ($owner in @(0,102,103,104,105,106)) {
  $owners = @(101,$owner)
  Assert-RejectedListener
}
Write-Output 'PASS gateway quoting and unexpected listeners'

$serverDir = 'C:\Users\uers\Downloads\secretary-pc'
$port = 3940
$parent = New-TestProcess 15080 'node.exe C:\Users\uers\Downloads\secretary-pc\node_modules\next\dist\bin\next start -p 3940'
$child = New-TestProcess 201 '"C:\Program Files\nodejs\node.exe" C:\Users\uers\Downloads\secretary-pc\node_modules\next\dist\server\lib\start-server.js' 15080 ([datetime]'2026-11-18T19:47:00')
$otherApp = New-TestProcess 202 'node.exe C:\Users\uers\Downloads\claude-mobile\node_modules\next\dist\server\lib\start-server.js' 15080 $child.CreationDate
$processes = @($child,$parent,$otherApp)
$owners = @(201)
Assert-ServerProcessIds @(15080,201)
$owners = @()
Assert-ServerProcessIds @(15080,201)
$owners = @(202)
Assert-RejectedListener

$parent.CommandLine = 'node.exe C:\Users\uers\Downloads\secretary-pc\node_modules\next\dist\bin\next start'
$owners = @(201)
Assert-ServerProcessIds @(15080,201)
$parent.CreationDate = $child.CreationDate.AddMinutes(1)
Assert-RejectedListener
$processes = @($child,$gateway)
Assert-RejectedListener
Write-Output 'PASS secretary worker, parent identity and PID reuse'
