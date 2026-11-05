# Registration only. The scheduled action never opens a console window.
param([switch]$FunctionsOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
function Get-ReopenDefinition($Task) {
    [ordered]@{
        Actions = @($Task.Actions | ForEach-Object { "$($_.Execute)|$($_.Arguments)" })
        Triggers = @($Task.Triggers | ForEach-Object { "$($_.CimClass.CimClassName)|$($_.UserId)|$($_.Delay)|$($_.Enabled)" })
        User = $Task.Principal.UserId; Logon = [string]$Task.Principal.LogonType; Level = [string]$Task.Principal.RunLevel
        Enabled = $Task.Settings.Enabled; Instances = [string]$Task.Settings.MultipleInstances
        Limit = $Task.Settings.ExecutionTimeLimit; Battery = $Task.Settings.DisallowStartIfOnBatteries
        StopBattery = $Task.Settings.StopIfGoingOnBatteries
    } | ConvertTo-Json -Depth 5 -Compress
}
function Register-ReopenLostTask(
    [scriptblock]$GetTask = { param($Name) Get-ScheduledTask -TaskPath '\' | Where-Object TaskName -eq $Name },
    [scriptblock]$RegisterTask = { param($Name, $Task) Register-ScheduledTask -TaskName $Name -TaskPath '\' -InputObject $Task -Force | Out-Null }
) {
    $name = 'OrgiastReopenLostSessions'
    $toolsDir = Resolve-RegisterToolsDir -Fallback $PSScriptRoot -RequiredLeaves @('reopen-lost-sessions.mjs')
    $file = Join-Path $toolsDir 'reopen-lost-sessions.mjs'
    $hidden = Join-Path $env:USERPROFILE '.claude\tools\run-hidden.vbs'
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    foreach ($required in @($file, $hidden, $node)) { if (-not (Test-Path -LiteralPath $required)) { throw "Missing: $required" } }
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $action = New-ScheduledTaskAction -Execute (Join-Path $env:WINDIR 'System32\wscript.exe') -Argument ('//nologo "{0}" "{1}" "{2}"' -f $hidden, $node, $file)
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $trigger.Delay = 'PT3M'
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    # No 60-second task limit: only API acquisition has that limit.
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit ([timespan]::Zero)
    $desired = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings
    $current = & $GetTask $name
    if ($current -and (Get-ReopenDefinition $current) -ceq (Get-ReopenDefinition $desired)) { return @{ changed = $false; taskName = $name } }
    & $RegisterTask $name $desired
    if ((Get-ReopenDefinition (& $GetTask $name)) -cne (Get-ReopenDefinition $desired)) { throw 'Task verification failed' }
    return @{ changed = $true; taskName = $name }
}
if (-not $FunctionsOnly) { Register-ReopenLostTask | ConvertTo-Json -Compress }
