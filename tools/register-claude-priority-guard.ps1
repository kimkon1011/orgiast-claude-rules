# Registration only. The scheduled action never opens a console window.
param([switch]$FunctionsOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
. (Join-Path $PSScriptRoot 'lib\Normalize-UserId.ps1')
function Get-PriorityGuardDefinition($Task) {
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
function Register-PriorityGuardTask(
    [scriptblock]$GetTask = { param($Name) Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq $Name },
    [scriptblock]$RegisterTask = { param($Name, $Task) Register-ScheduledTask -TaskName $Name -TaskPath '\' -InputObject $Task -Force | Out-Null }
) {
    $toolsDir = Resolve-RegisterToolsDir -Fallback $PSScriptRoot -RequiredLeaves @('claude-priority-guard.mjs')
    $file = Join-Path $toolsDir 'claude-priority-guard.mjs'
    $hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    foreach ($required in @($file, $hidden, $node)) { if (-not (Test-Path -LiteralPath $required)) { throw "Missing: $required" } }
    $user = $env:USERNAME

    $name1 = 'OrgiastClaudePriorityGuard'
    $action1 = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('//nologo "{0}" "{1}" "{2}"' -f $hidden, $node, $file)
    $trigger1a = New-ScheduledTaskTrigger -Once -At '2026-01-01T00:00:00' -RepetitionInterval (New-TimeSpan -Minutes 1)
    $trigger1b = New-ScheduledTaskTrigger -AtLogOn -User $user
    $trigger1b.Delay = 'PT1M'
    $principal1 = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings1 = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -Priority 5
    $desired1 = New-ScheduledTask -Action $action1 -Trigger @($trigger1a, $trigger1b) -Principal $principal1 -Settings $settings1

    $current1 = & $GetTask $name1
    $changed = $false
    if (-not $current1 -or (Get-PriorityGuardDefinition $current1) -cne (Get-PriorityGuardDefinition $desired1)) {
        & $RegisterTask $name1 $desired1
        if ((Get-PriorityGuardDefinition (& $GetTask $name1)) -cne (Get-PriorityGuardDefinition $desired1)) { throw "Task verification failed for $name1" }
        $changed = $true
    }

    return @{ changed = $changed }
}
if (-not $FunctionsOnly) { Register-PriorityGuardTask | ConvertTo-Json -Compress }
