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
        RestartCount = [string]$Task.Settings.RestartCount; RestartInterval = [string]$Task.Settings.RestartInterval
    } | ConvertTo-Json -Depth 5 -Compress
}
# マシンローカルの reopen-lost-sessions-*.mjs ラッパー。正本 reopen-lost-sessions.mjs は含めない。
function Find-ReopenWrapperPath([string]$Arguments) {
    if (-not $Arguments) { return $null }
    $match = [regex]::Match($Arguments, '(?i)([A-Za-z]:\\(?:[^"\r\n]*\\)?reopen-lost-sessions-[^"\\/]+\.mjs)')
    if (-not $match.Success) { return $null }
    $path = $match.Groups[1].Value
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    return $path
}
# 再登録（setup --converge 含む）でも、明示パスか既存タスクのローカルラッパーを正本で上書きしない。
# 優先順: -Override / ORGIAST_REOPEN_SCRIPT → 設定 JSON の script → 既存タスクのラッパー → 正本。
function Resolve-ReopenActionScript {
    param(
        [Parameter(Mandatory)][string]$Canonical,
        $Tasks,
        [string]$Override = $env:ORGIAST_REOPEN_SCRIPT,
        [string]$ConfigFile = $(Join-Path $env:USERPROFILE '.claude\reopen-lost-sessions.json')
    )
    if ($Override -and (Test-Path -LiteralPath $Override)) { return $Override }
    if ($ConfigFile -and (Test-Path -LiteralPath $ConfigFile)) {
        try {
            $configured = [string](Get-Content -LiteralPath $ConfigFile -Raw -ErrorAction Stop | ConvertFrom-Json).script
            if ($configured -and (Test-Path -LiteralPath $configured)) { return $configured }
        } catch { }
    }
    foreach ($task in @($Tasks)) {
        if (-not $task) { continue }
        foreach ($action in @($task.Actions)) {
            $found = Find-ReopenWrapperPath ([string]$action.Arguments)
            if ($found) { return $found }
        }
    }
    return $Canonical
}
function Register-ReopenLostTask(
    [scriptblock]$GetTask = { param($Name) Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq $Name },
    [scriptblock]$RegisterTask = { param($Name, $Task) Register-ScheduledTask -TaskName $Name -TaskPath '\' -InputObject $Task -Force | Out-Null },
    [string]$ScriptOverride = $env:ORGIAST_REOPEN_SCRIPT,
    [string]$ScriptConfigFile = $(Join-Path $env:USERPROFILE '.claude\reopen-lost-sessions.json')
) {
    $toolsDir = Resolve-RegisterToolsDir -Fallback $PSScriptRoot -RequiredLeaves @('reopen-lost-sessions.mjs')
    $canonical = Join-Path $toolsDir 'reopen-lost-sessions.mjs'
    $hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $user = $env:USERNAME

    $name1 = 'OrgiastReopenLostSessions'
    $name2 = 'OrgiastReopenLostSessionsWatch'
    $current1 = & $GetTask $name1
    $current2 = & $GetTask $name2
    $file = Resolve-ReopenActionScript -Canonical $canonical -Tasks @($current1, $current2) -Override $ScriptOverride -ConfigFile $ScriptConfigFile
    foreach ($required in @($canonical, $file, $hidden, $node)) { if (-not (Test-Path -LiteralPath $required)) { throw "Missing: $required" } }

    $action1 = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('//nologo "{0}" "{1}" "{2}"' -f $hidden, $node, $file)
    $trigger1 = New-ScheduledTaskTrigger -AtLogOn -User $user
    $trigger1.Delay = 'PT3M'
    # The action is a bounded one-shot. Polling makes it self-healing without a
    # resident process whose death would otherwise go unnoticed until logon.
    $trigger1b = New-ScheduledTaskTrigger -Once -At '2026-01-01T00:05:00' -RepetitionInterval (New-TimeSpan -Minutes 15)
    $principal1 = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings1 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([timespan]::Zero) -Priority 5
    $desired1 = New-ScheduledTask -Action $action1 -Trigger @($trigger1, $trigger1b) -Principal $principal1 -Settings $settings1

    $current1 = & $GetTask $name1
    $changed1 = $false
    if (-not $current1 -or (Get-ReopenDefinition $current1) -cne (Get-ReopenDefinition $desired1)) {
        & $RegisterTask $name1 $desired1
        if ((Get-ReopenDefinition (& $GetTask $name1)) -cne (Get-ReopenDefinition $desired1)) { throw "Task verification failed for $name1" }
        $changed1 = $true
    }

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
