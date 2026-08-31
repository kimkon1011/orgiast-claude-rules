# Orgiast auto-session の前夜結果を毎日 07:45 に検証する。
# Windows PowerShell 5.1 で日本語を安全に扱うため UTF-8 BOM で保存する。
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ensure-run-hidden.ps1')

$repo = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$fixedVerifier = Join-Path $env:USERPROFILE '.claude\auto-session-repo\tools\auto-session-verify.mjs'
$repoVerifier = Join-Path $repo 'tools\auto-session-verify.mjs'
$script = if (Test-Path $fixedVerifier) { $fixedVerifier } else { $repoVerifier }
if (-not (Test-Path $script)) { throw "script not found: $script" }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node not found. Install Node.js first.' }

$action = New-HiddenScheduledTaskAction -Execute $node -ChildArgument @($script) -WorkingDirectory $repo
$trigger = New-ScheduledTaskTrigger -Daily -At '07:45'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15)

Register-ScheduledTask -TaskName 'OrgiastAutoSessionVerify' -Action $action -Trigger $trigger -Settings $settings -Description '前夜の自動セッションを検証・自己修復して Discord へ通知' -Force | Out-Null
Write-Host 'OK: task OrgiastAutoSessionVerify registered (daily 07:45)'
