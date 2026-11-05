$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
$registration = 'C:\Users\uers\.claude\nightly-repo\.wt\morning-batch-health-timelimit\tools\register-nightly-tools.ps1'
$otherNames = @('OrgiastNightlyBatch', 'OrgiastDeadlineDetect', 'OrgiastDeadlineWatch', 'OrgiastNightlyRemediate')
$before = @{}
foreach ($name in $otherNames) { $before[$name] = Export-ScheduledTask -TaskName $name }
$morningBefore = [xml](Export-ScheduledTask -TaskName OrgiastMorningBatch)
& $registration -HealthOnly -DryRun
& $registration -HealthOnly
foreach ($name in $otherNames) {
  if ((Export-ScheduledTask -TaskName $name) -ne $before[$name]) { throw "unrelated task changed: $name" }
}
$morningAfter = [xml](Export-ScheduledTask -TaskName OrgiastMorningBatch)
$healthAfter = [xml](Export-ScheduledTask -TaskName OrgiastNightlyHealth)
if ($morningBefore.Task.Settings.OuterXml -ne $morningAfter.Task.Settings.OuterXml) { throw 'morning settings changed' }
if ($morningBefore.Task.Principals.OuterXml -ne $healthAfter.Task.Principals.OuterXml) { throw 'health principal differs' }
$healthAfter.Task.Settings.ExecutionTimeLimit = $morningBefore.Task.Settings.ExecutionTimeLimit
if ($morningBefore.Task.Settings.OuterXml -ne $healthAfter.Task.Settings.OuterXml) { throw 'health settings differ beyond time limit' }
Write-Host 'PASS: unrelated tasks unchanged; morning settings unchanged; health inherits principal and all settings except limit'
$result = @(Get-ScheduledTask -TaskName OrgiastMorningBatch,OrgiastNightlyHealth | ForEach-Object {
  [pscustomobject]@{
    TaskName=$_.TaskName
    Actions=@($_.Actions | Select-Object Execute,Arguments,WorkingDirectory)
    ExecutionTimeLimit=$_.Settings.ExecutionTimeLimit
    MultipleInstances=[string]$_.Settings.MultipleInstances
    Principal=($_.Principal | Select-Object UserId,LogonType,RunLevel)
    Triggers=@($_.Triggers | Select-Object StartBoundary,DaysInterval,Enabled)
  }
}) | ConvertTo-Json -Depth 5
$result | Set-Content -LiteralPath (Join-Path $PSScriptRoot 'task-readback.json') -Encoding UTF8
Write-Output $result
