# kim-PC の未完了依頼を30分ごとに追跡する。実登録はconverge時のみ。
param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastOffboardingWatch'
$node = (Get-Command node.exe -ErrorAction Stop).Source
# Avoid inline JavaScript quoting differences in Windows PowerShell 5.1.
& $node (Join-Path $PSScriptRoot 'register-offboarding-watch.mjs') --is-controller
if ($LASTEXITCODE -eq 2) { exit 0 }
if ($LASTEXITCODE -ne 0) { throw 'fleet label check failed' }
if ($Unregister) {
    $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
    exit 0
}
. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent $PSScriptRoot) -RequiredPaths @('tools\offboarding-watch.mjs')
$script = Join-Path $repo 'tools\offboarding-watch.mjs'
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw 'offboarding-watch.mjs not found' }
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script, '--notify', '--apply-revoke') -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '07:10'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'kim-PC: 退職者監視・PC失効(毎日07:10)' -Force | Out-Null
Write-Host "OK: task $taskName registered (daily 07:10, limit 20 min)"
