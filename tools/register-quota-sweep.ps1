# OrgiastQuotaSweep: 15分ごとに実測枠を判定。既存タスクは更新。
param([switch]$ValidateOnly)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\quota-sweep.mjs', 'tools\lib\quota-windows.mjs', 'tools\quota-sweep-contract.tmpl.md')
$script = Join-Path $repo 'tools\quota-sweep.mjs'
$nodeExe = (Get-Command node -CommandType Application -ErrorAction Stop | Where-Object Extension -eq '.exe' | Select-Object -First 1).Source
if (-not $nodeExe) { throw 'Node executable missing' }
if ($ValidateOnly) {
  & $nodeExe --check $script
  if ($LASTEXITCODE -ne 0) { throw 'Node構文検証に失敗しました' }
  Write-Host ('検証のみ: ' + $script + ' / 15分 / PT2H30M')
  return
}
$action = New-HiddenScheduledTaskAction -Execute $nodeExe -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 15)
$query = '<QueryList><Query Id="0" Path="System"><Select Path="System">*[System[Provider[@Name=''Microsoft-Windows-Power-Troubleshooter''] and EventID=1]]</Select></Query></QueryList>'
$class = Get-CimClass -ClassName MSFT_TaskEventTrigger -Namespace Root/Microsoft/Windows/TaskScheduler
$wake = New-CimInstance -CimClass $class -ClientOnly
$wake.Subscription = $query
$wake.Delay = 'PT1M'
$wake.Enabled = $true
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 150)
Register-ScheduledTask -TaskName 'OrgiastQuotaSweep' -Action $action -Trigger @($trigger,$wake) -Settings $settings -Description 'Claude/Codex の枠リセット直前に残枠を makeloop で消化(15分ごと判定)' -Force | Out-Null
$task = Get-ScheduledTask -TaskName 'OrgiastQuotaSweep' -ErrorAction Stop
if ($task.Settings.ExecutionTimeLimit -ne 'PT2H30M' -or $task.Actions.Arguments -notlike '*quota-sweep.mjs*' -or $task.Triggers.Repetition.Interval -notcontains 'PT15M') { throw '登録後の読戻し検証に失敗しました' }
& schtasks.exe /Query /TN OrgiastQuotaSweep
if ($LASTEXITCODE -ne 0) { throw 'schtasks確認に失敗しました' }
Write-Host '登録・読戻し確認済み: OrgiastQuotaSweep / PT15M / PT2H30M'
