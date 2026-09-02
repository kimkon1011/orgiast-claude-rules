# apply-nightly-schedule.ps1 -- spread nightly Scheduled Task triggers safely.
# This change is reversible. To restore the old schedule, rerun equivalent trigger updates with the old times.
[CmdletBinding()]
param(
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$randomDelay = New-TimeSpan -Minutes 2
$definitions = @(
    [pscustomobject]@{ Name = 'OrgiastNightlyBatch'; Kind = 'Daily'; At = '03:00' },
    [pscustomobject]@{ Name = 'OrgiastBoothFeedbackIntake'; Kind = 'Daily'; At = '03:06' },
    [pscustomobject]@{ Name = 'Orgiast Growi 自動クリーンアップ'; Kind = 'Daily'; At = '03:12' },
    [pscustomobject]@{ Name = 'OrgiastPlaudToTldv'; Kind = 'Hourly'; At = '00:08' }
)

function New-NightlyTrigger([pscustomobject]$Definition) {
    $at = [DateTime]::Today.Add([TimeSpan]::ParseExact($Definition.At, 'hh\:mm', $null))
    if ($Definition.Kind -eq 'Hourly') {
        return New-ScheduledTaskTrigger -Once -At $at -RepetitionInterval (New-TimeSpan -Hours 1) -RandomDelay $randomDelay
    }
    return New-ScheduledTaskTrigger -Daily -At $at -RandomDelay $randomDelay
}

function Format-Trigger($Trigger) {
    $start = if ($Trigger.StartBoundary) { ([DateTime]$Trigger.StartBoundary).ToString('yyyy-MM-dd HH:mm:ss') } else { '(none)' }
    $interval = if ($Trigger.Repetition.Interval) { $Trigger.Repetition.Interval } else { '(none)' }
    return "Start=$start RandomDelay=$($Trigger.RandomDelay) Repetition=$interval"
}

foreach ($definition in $definitions) {
    $task = Get-ScheduledTask -TaskName $definition.Name -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Host ("SKIP(なし): {0}" -f $definition.Name)
        continue
    }

    $newTrigger = New-NightlyTrigger $definition
    Write-Host ("{0}: {1} -> {2} RandomDelay=00:02:00" -f $(if ($DryRun) { 'DRY-RUN' } else { 'UPDATE' }), $definition.Name, $definition.At)
    if ($DryRun) { continue }

    Set-ScheduledTask -TaskName $definition.Name -Trigger $newTrigger -ErrorAction Stop | Out-Null
    $verified = Get-ScheduledTask -TaskName $definition.Name -ErrorAction Stop
    Write-Host ("VERIFY: {0}: {1}" -f $definition.Name, (Format-Trigger $verified.Triggers[0]))
}
