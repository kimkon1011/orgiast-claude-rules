# Registration only. The scheduled action never opens a console window.
param([switch]$FunctionsOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
. (Join-Path $PSScriptRoot 'lib\Normalize-UserId.ps1')
function Get-ReopenDefinition($Task) {
    [ordered]@{
        Actions = @($Task.Actions | ForEach-Object { "$($_.Execute)|$($_.Arguments)" })
        Triggers = @($Task.Triggers | ForEach-Object {
            $sb = if ($_.StartBoundary) { [datetime]::Parse($_.StartBoundary).ToString('yyyy-MM-ddTHH:mm:ss') } else { '' }
            "$($_.CimClass.CimClassName)|$(Normalize-UserId $_.UserId)|$($_.Delay)|$($_.Enabled)|$sb|$($_.Repetition.Interval)|$($_.Repetition.Duration)"
        })
        User = (Normalize-UserId $Task.Principal.UserId); Logon = [string]$Task.Principal.LogonType; Level = [string]$Task.Principal.RunLevel
        Enabled = $Task.Settings.Enabled; Instances = [string]$Task.Settings.MultipleInstances
        Limit = $Task.Settings.ExecutionTimeLimit; Battery = $Task.Settings.DisallowStartIfOnBatteries
        StopBattery = $Task.Settings.StopIfGoingOnBatteries; Priority = [string]$Task.Settings.Priority
    } | ConvertTo-Json -Depth 5 -Compress
}
function Register-ReopenLostTask(
    [scriptblock]$GetTask = { param($Name) Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq $Name },
    [scriptblock]$RegisterTask = { param($Name, $Task) Register-ScheduledTask -TaskName $Name -TaskPath '\' -InputObject $Task -Force | Out-Null }
) {
    $toolsDir = Resolve-RegisterToolsDir -Fallback $PSScriptRoot -RequiredLeaves @('reopen-lost-sessions.mjs')
    $file = Join-Path $toolsDir 'reopen-lost-sessions.mjs'
    $hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    foreach ($required in @($file, $hidden, $node)) { if (-not (Test-Path -LiteralPath $required)) { throw "Missing: $required" } }
    $user = $env:USERNAME

    $name1 = 'OrgiastReopenLostSessions'
    $action1 = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('//nologo "{0}" "{1}" "{2}"' -f $hidden, $node, $file)
    $trigger1 = New-ScheduledTaskTrigger -AtLogOn -User $user
    $trigger1.Delay = 'PT3M'
    $principal1 = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings1 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([timespan]::Zero) -Priority 5
    $desired1 = New-ScheduledTask -Action $action1 -Trigger $trigger1 -Principal $principal1 -Settings $settings1

    $current1 = & $GetTask $name1
    $changed1 = $false
    if (-not $current1 -or (Get-ReopenDefinition $current1) -cne (Get-ReopenDefinition $desired1)) {
        & $RegisterTask $name1 $desired1
        if ((Get-ReopenDefinition (& $GetTask $name1)) -cne (Get-ReopenDefinition $desired1)) { throw "Task verification failed for $name1" }
        $changed1 = $true
    }

    $name2 = 'OrgiastReopenLostSessionsWatch'
    $action2 = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('//nologo "{0}" "{1}" "{2}" "--watch"' -f $hidden, $node, $file)
    # 2026-11-13: Two offset triggers ran about every 7.5 minutes and accumulated claude.exe processes.
    # Keep one fixed, indefinite 15-minute trigger; logon recovery remains in task1 (PT3M).
    $trigger2b = New-ScheduledTaskTrigger -Once -At '2026-01-01T00:00:00' -RepetitionInterval (New-TimeSpan -Minutes 15)
    $principal2 = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings2 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -Priority 5
    $desired2 = New-ScheduledTask -Action $action2 -Trigger $trigger2b -Principal $principal2 -Settings $settings2

    $current2 = & $GetTask $name2
    $changed2 = $false
    if (-not $current2 -or (Get-ReopenDefinition $current2) -cne (Get-ReopenDefinition $desired2)) {
        & $RegisterTask $name2 $desired2
        if ((Get-ReopenDefinition (& $GetTask $name2)) -cne (Get-ReopenDefinition $desired2)) { throw "Task verification failed for $name2" }
        $changed2 = $true
    }

    return @{ changed = ($changed1 -or $changed2); tasks = @{ $name1 = $changed1; $name2 = $changed2 } }
}
if (-not $FunctionsOnly) { Register-ReopenLostTask | ConvertTo-Json -Compress }
