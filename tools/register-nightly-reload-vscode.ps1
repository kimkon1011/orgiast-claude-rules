# Registration only: never starts the task or VS Code.
param([switch]$FunctionsOnly)
$ErrorActionPreference = 'Stop'
function Get-NightlyTaskDefinition($Task) {
    $triggers = @($Task.Triggers | ForEach-Object {
        [ordered]@{ Type = $_.CimClass.CimClassName; Time = ([datetime]$_.StartBoundary).ToString('HH:mm:ss');
            Days = $_.DaysInterval; Enabled = $_.Enabled; End = $_.EndBoundary;
            RandomDelay = $_.RandomDelay; Repeat = $_.Repetition.Interval; Duration = $_.Repetition.Duration }
    } | Sort-Object { $_.Time })
    [ordered]@{
        Actions = @($Task.Actions | ForEach-Object { [ordered]@{ Execute = $_.Execute; Arguments = $_.Arguments; WorkingDirectory = $_.WorkingDirectory } })
        Triggers = $triggers
        User = $Task.Principal.UserId; Logon = [string]$Task.Principal.LogonType; RunLevel = [string]$Task.Principal.RunLevel
        Enabled = $Task.Settings.Enabled; Instances = [string]$Task.Settings.MultipleInstances
        Battery = $Task.Settings.DisallowStartIfOnBatteries; StopBattery = $Task.Settings.StopIfGoingOnBatteries
        StartWhenAvailable = $Task.Settings.StartWhenAvailable; Wake = $Task.Settings.WakeToRun
        Limit = $Task.Settings.ExecutionTimeLimit; Idle = $Task.Settings.RunOnlyIfIdle
        Network = $Task.Settings.RunOnlyIfNetworkAvailable
    } | ConvertTo-Json -Depth 8 -Compress
}
function Register-NightlyReloadTask {
    $name = 'OrgiastNightlyReloadVSCode'
    $scriptFile = Join-Path $PSScriptRoot 'nightly-reload-vscode.ps1'
    if (-not (Test-Path -LiteralPath $scriptFile)) { throw "Missing script: $scriptFile" }
    $action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $scriptFile)
    $triggers = @('04:40', '05:00', '05:20', '05:40', '06:00') | ForEach-Object {
        New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact("2020-01-01 $_", 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture))
    }
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType Interactive -RunLevel Limited
    # No catch-up outside the night window; no overlapping restart attempts.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 19)
    $desired = New-ScheduledTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings
    # Enumerating first distinguishes a missing task from a scheduler/access failure.
    $current = Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq $name
    if ($current -and (Get-NightlyTaskDefinition $current) -ceq (Get-NightlyTaskDefinition $desired)) {
        return @{ changed = $false; taskName = $name }
    }
    Register-ScheduledTask -TaskName $name -TaskPath '\' -InputObject $desired -Force | Out-Null
    $actual = Get-ScheduledTask -TaskName $name -TaskPath '\'
    if ((Get-NightlyTaskDefinition $actual) -cne (Get-NightlyTaskDefinition $desired)) { throw 'Task definition verification failed' }
    return @{ changed = $true; taskName = $name }
}
if (-not $FunctionsOnly) { Register-NightlyReloadTask | ConvertTo-Json -Compress }
