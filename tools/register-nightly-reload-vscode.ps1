# Registration only: never starts the task or VS Code.
param([switch]$FunctionsOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
. (Join-Path $PSScriptRoot 'lib\Normalize-UserId.ps1')
function Get-NightlyTaskDefinition($Task) {
    $triggers = @($Task.Triggers | ForEach-Object {
        [ordered]@{ Type = $_.CimClass.CimClassName; Time = ([datetime]$_.StartBoundary).ToString('HH:mm:ss');
            Days = $_.DaysInterval; Enabled = $_.Enabled; End = $_.EndBoundary;
            RandomDelay = $_.RandomDelay; Repeat = $_.Repetition.Interval; Duration = $_.Repetition.Duration }
    } | Sort-Object { $_.Time })
    [ordered]@{
        Actions = @($Task.Actions | ForEach-Object { [ordered]@{ Execute = $_.Execute; Arguments = $_.Arguments; WorkingDirectory = $_.WorkingDirectory } })
        Triggers = $triggers
        User = (Normalize-UserId $Task.Principal.UserId); Logon = [string]$Task.Principal.LogonType; RunLevel = [string]$Task.Principal.RunLevel
        Enabled = $Task.Settings.Enabled; Instances = [string]$Task.Settings.MultipleInstances
        Battery = $Task.Settings.DisallowStartIfOnBatteries; StopBattery = $Task.Settings.StopIfGoingOnBatteries
        StartWhenAvailable = $Task.Settings.StartWhenAvailable; Wake = $Task.Settings.WakeToRun
        Limit = $Task.Settings.ExecutionTimeLimit; Idle = $Task.Settings.RunOnlyIfIdle
        Network = $Task.Settings.RunOnlyIfNetworkAvailable
    } | ConvertTo-Json -Depth 8 -Compress
}
# Scheduler calls are injectable: function shadowing does not reliably override the
# ScheduledTasks module cmdlets, and a test must never reach the real scheduler.
function Register-NightlyReloadTask(
    # Enumerating (not -TaskName) distinguishes a missing task from a scheduler/access failure.
    [scriptblock]$GetTask = { param($TaskName) Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq $TaskName },
    [scriptblock]$DisableTask = { param($TaskName) Disable-ScheduledTask -TaskName $TaskName -TaskPath '\' | Out-Null },
    [scriptblock]$RegisterTask = { param($TaskName, $InputObject) Register-ScheduledTask -TaskName $TaskName -TaskPath '\' -InputObject $InputObject -Force | Out-Null }
) {
    $legacyChanged = $false
    $legacy = & $GetTask 'ClaudeNightlyReloadVSCode'
    if ($legacy -and $legacy.Settings.Enabled) {
        & $DisableTask 'ClaudeNightlyReloadVSCode'
        if ((& $GetTask 'ClaudeNightlyReloadVSCode').Settings.Enabled) { throw 'Legacy task still enabled' }
        $legacyChanged = $true
    }
    $name = 'OrgiastNightlyReloadVSCode'
    $toolsDir = Resolve-RegisterToolsDir -Fallback $PSScriptRoot
    $scriptFile = Join-Path $toolsDir 'nightly-reload-vscode.ps1'
    if (-not (Test-Path -LiteralPath $scriptFile)) { throw "Missing script: $scriptFile" }
    $action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $scriptFile)
    $triggers = @('04:40', '05:00', '05:20', '05:40', '06:00') | ForEach-Object {
        New-ScheduledTaskTrigger -Daily -At ([datetime]::ParseExact("2020-01-01 $_", 'yyyy-MM-dd HH:mm', [Globalization.CultureInfo]::InvariantCulture))
    }
    $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value) -LogonType Interactive -RunLevel Limited
    # No catch-up outside the night window; no overlapping restart attempts.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 19)
    $desired = New-ScheduledTask -Action $action -Trigger $triggers -Principal $principal -Settings $settings
    $current = & $GetTask $name
    if ($current -and (Get-NightlyTaskDefinition $current) -ceq (Get-NightlyTaskDefinition $desired)) {
        return @{ changed = $legacyChanged; taskName = $name }
    }
    & $RegisterTask $name $desired
    $actual = & $GetTask $name
    if ((Get-NightlyTaskDefinition $actual) -cne (Get-NightlyTaskDefinition $desired)) { throw 'Task definition verification failed' }
    return @{ changed = $true; taskName = $name }
}
if (-not $FunctionsOnly) { Register-NightlyReloadTask | ConvertTo-Json -Compress }
