# Orgiast AI廃人部の週次取り込みを毎週日曜03:20に起動する。Windows PowerShell 5.1向けUTF-8 BOM。
# 実行対象(aihaijin-digest.mjs)は作業ツリーではなく nightly-bootstrap が origin/main へ同期した
# チェックアウト(~/.claude/nightly-repo)から実行する(2026-09-10・nightly-batch と同様の分離)。
# Facebook の読み取りと、運用ルールへの改善候補の取り込み。
param([switch]$Unregister)
$ErrorActionPreference = 'Stop'
$taskName = 'OrgiastAihaijinDigest'

if ($Unregister) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host "OK: task $taskName unregistered" }
  else { Write-Host "OK: task $taskName was not registered" }
  exit 0
}

# converge と同じ対象条件。手動起動でも未設定PCに登録しない。
$profileHome = $env:ORGIAST_HOME
if (-not $profileHome) { $profileHome = $env:USERPROFILE }
if (-not (Test-Path -LiteralPath (Join-Path $profileHome '.claude\messenger-profile') -PathType Container)) {
  Write-Host 'SKIP: Messenger profile is not configured'
  exit 0
}

. (Join-Path $PSScriptRoot 'resolve-synced-repo.ps1')
# The task must run from the synced repo, not from the tree this script sits in.
$repo = Resolve-RegisterRepoRoot -Fallback (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)) -RequiredPaths @('tools\aihaijin-digest.mjs', 'tools\nightly-bootstrap.ps1')
$target = 'tools\aihaijin-digest.mjs'
$script = Join-Path $repo $target
if (-not (Test-Path -LiteralPath $script -PathType Leaf)) { throw "aihaijin-digest.mjs not found: $script" }
$bootstrapSource = Join-Path $repo 'tools\nightly-bootstrap.ps1'
if (-not (Test-Path -LiteralPath $bootstrapSource -PathType Leaf)) { throw "nightly-bootstrap.ps1 not found: $bootstrapSource" }
$bootstrapDir = Join-Path $env:USERPROFILE '.claude\tools'
$bootstrap = Join-Path $bootstrapDir 'nightly-bootstrap.ps1'
New-Item -ItemType Directory -Force -Path $bootstrapDir | Out-Null
Copy-Item -LiteralPath $bootstrapSource -Destination $bootstrap -Force

. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')
$action = New-HiddenScheduledTaskAction -Execute 'powershell.exe' -ChildArgument @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $bootstrap, '-Target', $target) -WorkingDirectory $repo
# 日曜03:20。最大10分のランダム遅延でアクセスを分散する。
$trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Sunday -At '03:20' -RandomDelay (New-TimeSpan -Minutes 10)
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

try {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'AI廃人部の投稿を毎週取り込み、運用改善候補をルールへ反映する' -Force | Out-Null
} catch {
  if ($_.Exception.Message -match 'Access is denied|Access Denied|0x80070005|アクセスが拒否') {
    throw "Access Denied: 現在のユーザーでタスクを再登録できません。既存の $taskName を同じユーザーで削除してから再実行してください。"
  }
  throw
}
Write-Host "OK: task $taskName registered (Sunday 03:20, random delay up to 10 min, limit 2 hours)"
Get-ScheduledTask -TaskName $taskName | Select-Object TaskName, State
