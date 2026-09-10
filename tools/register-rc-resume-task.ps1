# OrgiastRcResumeOnWake を新規登録または更新する（実行自体はこの登録スクリプトでは行わない）。
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastRcResumeOnWake'
$repoRoot = Split-Path -Parent $PSScriptRoot
$mobileScript = Join-Path $repoRoot 'tools\mobile-sessions.mjs'
if (-not (Test-Path -LiteralPath $mobileScript)) { throw "mobile-sessions.mjs が見つかりません: $mobileScript" }
$logDirectory = Join-Path $env:USERPROFILE '.claude'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null

$node = (Get-Command node.exe -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) { $node = (Get-Command node -ErrorAction Stop | Select-Object -First 1).Source }
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function Escape-Xml([string]$Value) { return [Security.SecurityElement]::Escape($Value) }

$commandLine = '"{0}" "{1}" --count 3 --recreate >> "%USERPROFILE%\.claude\rc-resume-on-wake.log" 2>&1 & echo %DATE% %TIME% EXIT:!ERRORLEVEL! >> "%USERPROFILE%\.claude\rc-resume-on-wake.log"' -f $node, $mobileScript
$escapedCommandLine = Escape-Xml $commandLine
$escapedUserId = Escape-Xml $userId
$subscription = Escape-Xml '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name="Microsoft-Windows-Power-Troubleshooter"] and EventID=1]]</Select></Query></QueryList>'

$xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Restore Orgiast mobile Remote Control sessions after wake or unlock.</Description></RegistrationInfo>
  <Triggers>
    <EventTrigger><Enabled>true</Enabled><Subscription>$subscription</Subscription><Delay>PT90S</Delay></EventTrigger>
    <SessionStateChangeTrigger><Enabled>true</Enabled><StateChange>SessionUnlock</StateChange><Delay>PT90S</Delay><UserId>$escapedUserId</UserId></SessionStateChangeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$escapedUserId</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><AllowHardTerminate>true</AllowHardTerminate><ExecutionTimeLimit>PT10M</ExecutionTimeLimit><WakeToRun>true</WakeToRun><Enabled>true</Enabled></Settings>
  <Actions Context="Author"><Exec><Command>cmd.exe</Command><Arguments>/d /s /v:on /c "$escapedCommandLine"</Arguments></Exec></Actions>
</Task>
"@

Register-ScheduledTask -TaskName $taskName -Xml $xml -Force | Out-Null
Write-Output "REGISTERED: $taskName (wake + session unlock, delay 90s)"
