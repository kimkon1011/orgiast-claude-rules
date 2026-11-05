# LINE受信ログの毎時追記。Windows PowerShell 5.1向けUTF-8 BOM。
param([switch]$Unregister, [switch]$UpdateActionOnly)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastLineLogExport'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: task $taskName unregistered" }
  else { Write-Host "OK: task $taskName was not registered" }
  exit 0
}

. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# The task must run from the synced repo, not from the tree this script sits in.
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\line-log-export.mjs', 'tools\nightly-bootstrap.ps1')
$target = 'tools\line-log-export.mjs'
$script = Join-Path $repo $target
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "line-log-export.mjs not found: $script" }
$bootstrapSource = Join-Path $repo 'tools\nightly-bootstrap.ps1'
if (-not (Test-Path -LiteralPath $bootstrapSource -PathType Leaf)) { throw "nightly-bootstrap.ps1 not found: $bootstrapSource" }
$bootstrapDir = Join-Path $env:USERPROFILE '.claude\tools'
$bootstrap = Join-Path $bootstrapDir 'nightly-bootstrap.ps1'
New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
Copy-Item -LiteralPath $bootstrapSource -Destination $bootstrap -Force

. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', $target) -WorkingDirectory $repo
# Existing installations can migrate without replacing their schedule or principal.
if ($UpdateActionOnly) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
  Set-ScheduledTask -TaskName $existing.TaskName -TaskPath $existing.TaskPath -Action $action | Out-Null
  Write-Host "OK: task $taskName action updated; schedule and settings preserved"
  Get-ScheduledTask -TaskName $taskName | Select-Object -ExpandProperty Actions
  exit 0
}
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Hours 1) -RandomDelay (New-TimeSpan -Minutes 3)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'LINE受信ログを終日1時間ごとにGoogleシートへ追記する' -Force | Out-Null
} catch {
  if ($_.Exception.Message -match 'Access is denied|Access Denied|0x80070005|アクセスが拒否') {
    throw "Access Denied: 現在のユーザーでタスクを再登録できません。既存の $taskName を同じユーザーで削除してから再実行してください。"
  }
  throw
}
Write-Host "OK: task $taskName registered (hourly all day, random delay up to 3 min, limit 10 min)"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
