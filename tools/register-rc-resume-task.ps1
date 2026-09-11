# Register/update OrgiastRcResumeOnWake; -Run is the scheduled action only.
[CmdletBinding()]
param([switch]$Run, [switch]$FunctionsOnly)

$ErrorActionPreference = 'Stop'

function Get-RcResumeTaskXml([string]$UserId, [string]$PowerShellPath, [string]$ScriptPath) {
    $userXml = [Security.SecurityElement]::Escape($UserId)
    $commandXml = [Security.SecurityElement]::Escape($PowerShellPath)
    $argumentsXml = [Security.SecurityElement]::Escape('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $ScriptPath + '" -Run')
    $subscription = [Security.SecurityElement]::Escape('<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name="Microsoft-Windows-Power-Troubleshooter"] and EventID=1]]</Select></Query></QueryList>')
    return @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>Restore Orgiast mobile Remote Control sessions after wake or unlock.</Description></RegistrationInfo>
  <Triggers>
    <EventTrigger><Enabled>true</Enabled><Subscription>$subscription</Subscription><Delay>PT90S</Delay></EventTrigger>
    <SessionStateChangeTrigger><Enabled>true</Enabled><Delay>PT90S</Delay><UserId>$userXml</UserId><StateChange>SessionUnlock</StateChange></SessionStateChangeTrigger>
  </Triggers>
  <Principals><Principal id="Author"><UserId>$userXml</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><ExecutionTimeLimit>PT10M</ExecutionTimeLimit></Settings>
  <Actions Context="Author"><Exec><Command>$commandXml</Command><Arguments>$argumentsXml</Arguments></Exec></Actions>
</Task>
"@
}

if ($FunctionsOnly) { return }
$mobileScript = Join-Path $PSScriptRoot 'mobile-sessions.mjs'
if (-not (Test-Path -LiteralPath $mobileScript)) { throw "mobile-sessions.mjs missing: $mobileScript" }

if ($Run) {
    $logDirectory = Join-Path $env:USERPROFILE '.claude'
    New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
    $logPath = Join-Path $logDirectory 'rc-resume-on-wake.log'
    $exitCode = 1
    try {
        Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) START: mobile sessions recovery"
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        & $node $mobileScript --count 3 --recreate 2>&1 | ForEach-Object {
            Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) $_"
        }
        $exitCode = $LASTEXITCODE
    } catch {
        Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) ERROR: $($_.Exception.Message)"
    } finally {
        Add-Content -LiteralPath $logPath -Encoding utf8 -Value "$(Get-Date -Format o) EXIT: $exitCode (URI dispatch; session health is logged by the extension)"
    }
    exit $exitCode
}

$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source
$userId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$xml = Get-RcResumeTaskXml $userId $pwsh $PSCommandPath
Register-ScheduledTask -TaskName 'OrgiastRcResumeOnWake' -Xml $xml -Force | Out-Null
Write-Output 'REGISTERED: OrgiastRcResumeOnWake (wake + session unlock, delay 90s)'
