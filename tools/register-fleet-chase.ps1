# kim-PC の未完了依頼を30分ごとに追跡する。実登録はconverge時のみ。
param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastFleetChase'
$node = (Get-Command node.exe -ErrorAction Stop).Source
# Avoid inline JavaScript quoting differences in Windows PowerShell 5.1.
& $node (Join-Path $PSScriptRoot 'register-fleet-chase.mjs') --is-controller
if ($LASTEXITCODE -eq 2) { exit 0 }
if ($LASTEXITCODE -ne 0) { throw 'fleet label check failed' }
if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    exit 0
}
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\fleet-chase.mjs')
$script = Join-Path $repo 'tools\fleet-chase.mjs'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'fleet-chase.mjs not found' }
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '00:00'
$repetition = New-ScheduledTaskTrigger -Once -At '00:00' -RepetitionInterval (New-TimeSpan -Minutes 30) -RepetitionDuration (New-TimeSpan -Hours 24)
$trigger.Repetition = $repetition.Repetition
# 2件 x 20分 + 通信時間。重複起動はTask Schedulerとledger lockの両方で抑止。
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 50) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'kim-PC: fleet未完了依頼の台帳・追跡・自動消化(30分)' -Force | Out-Null
Write-Host "OK: task $taskName registered (every 30 minutes, limit 50 min)"
