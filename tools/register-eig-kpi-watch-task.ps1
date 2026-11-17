param([switch]$DryRun)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$script = Join-Path $PSScriptRoot 'eig-kpi-watch.mjs'
if (-not (Test-Path -LiteralPath $script)) { throw 'KPI script missing' }
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$escape = { param($value) [Security.SecurityElement]::Escape($value) }
$nodeXml = & $escape $node
$repoXml = & $escape $repo
$scriptXml = & $escape ('"' + $script + '"')
$userXml = & $escape $identity
# Use the existing hidden wrapper when installed, retaining the full node path.
$hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
if (Test-Path -LiteralPath $hidden) {
  $commandXml = & $escape (Join-Path $env:SystemRoot 'System32\wscript.exe')
  $argumentsXml = & $escape ('//nologo "{0}" "{1}" "{2}"' -f $hidden, $node, $script)
} else { $commandXml = $nodeXml; $argumentsXml = $scriptXml }
$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>260430EIG KPI watch, JST 08:30 and 17:30 through 2026-12-12. Read sources; append KPI and local kim-inbox only.</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger><StartBoundary>2026-11-17T08:30:00+09:00</StartBoundary><EndBoundary>2026-12-12T23:59:59+09:00</EndBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
    <CalendarTrigger><StartBoundary>2026-11-17T17:30:00+09:00</StartBoundary><EndBoundary>2026-12-12T23:59:59+09:00</EndBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$userXml</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><AllowStartOnDemand>true</AllowStartOnDemand><Enabled>true</Enabled><Hidden>true</Hidden><WakeToRun>true</WakeToRun><ExecutionTimeLimit>PT30M</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>$commandXml</Command><Arguments>$argumentsXml</Arguments><WorkingDirectory>$repoXml</WorkingDirectory></Exec></Actions>
</Task>
"@
if ($DryRun) { Write-Output $xml; exit 0 }
$xmlPath = Join-Path $env:TEMP ('eig-kpi-task-' + [guid]::NewGuid().ToString() + '.xml')
try {
  [IO.File]::WriteAllText($xmlPath, $xml, [Text.Encoding]::Unicode)
  & schtasks.exe /Create /TN 'EIG-KPI-Watch' /XML $xmlPath /F
  if ($LASTEXITCODE -ne 0) { throw 'schtasks registration failed' }
} finally { Remove-Item -LiteralPath $xmlPath -Force -ErrorAction SilentlyContinue }
& schtasks.exe /Query /TN 'EIG-KPI-Watch' /V /FO LIST
if ($LASTEXITCODE -ne 0) { throw 'schtasks read-back failed' }
$task = Get-ScheduledTask -TaskName 'EIG-KPI-Watch'
if (@($task.Triggers).Count -ne 2 -or @($task.Triggers | Where-Object { $_.EndBoundary -notlike '2026-12-12T23:59:59*' }).Count -gt 0) { throw 'Trigger read-back mismatch' }
$task.Triggers | Select-Object StartBoundary, EndBoundary, DaysInterval, Enabled
$task.Actions | Select-Object Execute, Arguments, WorkingDirectory
